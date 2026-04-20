require('dotenv').config();
const express = require('express');
const axios = require('axios');
const products = require('./products');
const { connectDB, Customer } = require('./db');

const app = express();
app.use(express.json());

// Connect MongoDB
connectDB();

// Duplicate message protection
// Stores last processed message ID per phone
const recentMessages = new Map();

// Health check
app.get('/', (req, res) => {
  res.status(200).send('GlassChat server is running!');
});

// WEBHOOK VERIFICATION
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' &&
      token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// RECEIVE ALL MESSAGES
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    // DUPLICATE MESSAGE PROTECTION
    const messageId = message.id;
    if (recentMessages.has(messageId)) {
      console.log('Duplicate message ignored:', messageId);
      return res.sendStatus(200);
    }
    recentMessages.set(messageId, Date.now());

    // Clean old entries from map after 10 seconds
    setTimeout(() => {
      recentMessages.delete(messageId);
    }, 10000);

    const userPhone = message.from;
    const messageType = message.type;

    // Get or create customer
    let customer = await getOrCreateCustomer(userPhone);
    if (!customer) return res.sendStatus(200);

    // BUTTON TAP HANDLER
    if (messageType === 'interactive') {
      const buttonId =
        message.interactive?.button_reply?.id;
      console.log(`Button: ${buttonId} from ${userPhone}`);

      if (buttonId === 'view_collection') {
        await updateCustomerStage(userPhone, 'browsing');
        await sendAllProductImages(userPhone);

      } else if (buttonId === 'todays_offers') {
        await sendTextMessage(userPhone,
          "*Today's Special Offers*\n\n" +
          "- Buy 2 shirts = 10% OFF\n" +
          "- Buy 3 shirts = 20% OFF\n" +
          "- Free delivery on orders above ₹999\n\n" +
          "Check out our collection below!"
        );
        await sendWelcomeButtons(userPhone);

      } else if (buttonId === 'talk_agent') {
        await sendTextMessage(userPhone,
          "Our agent is available 9AM - 6PM.\n\n" +
          "Meanwhile, feel free to browse our collection!"
        );
        await sendWelcomeButtons(userPhone);
      }
      return res.sendStatus(200);
    }

    // TEXT MESSAGE HANDLER
    if (messageType === 'text') {
      const userText = message.text.body.trim();
      console.log(`${userPhone}: ${userText}`);

      // NEW CUSTOMER - show welcome buttons
      if (customer.session.stage === 'new') {
        await sendWelcomeButtons(userPhone);
        return res.sendStatus(200);
      }

      // DETECT PRODUCT CODES
      const detectedCodes = detectProductCodes(userText);

      if (
        detectedCodes.length > 0 &&
        customer.session.stage === 'browsing'
      ) {
        // Save selected products to DB
        await updateCustomerSession(userPhone, {
          'session.stage': 'confirmed',
          'session.cart': detectedCodes.map(code => ({
            code: code,
            name: products[code].name,
            color: products[code].color,
            pricePerItem: products[code].price
          }))
        });

        // Refresh customer data
        customer = await Customer.findOne({
          phone: userPhone
        });

        // Send order summary
        await sendOrderSummary(userPhone, customer);
        return res.sendStatus(200);
      }

      // GEMINI HANDLES CONVERSATION
      // Refresh customer to get latest data
      customer = await Customer.findOne({
        phone: userPhone
      });

      // Build context for Gemini
      const customerContext = buildCustomerContext(customer);

      // Build system prompt
      const systemPrompt =
`You are Niya, a friendly sales assistant for ${process.env.BUSINESS_NAME || 'Ashirwad Apparels'} in ${process.env.BUSINESS_CITY || 'Ahmedabad'}.

CUSTOMER INFO:
${customerContext}

YOUR PERSONALITY:
- Talk like a helpful friend, not a robot
- Keep replies short and simple
- Use simple English by default
- If customer writes in Gujarati or Hindi, reply in that language simply
- Never say you are an AI
- Ask only one question at a time
- Use emojis only when needed, not in every line
- If reply needs to be long, use clear line breaks and points

YOUR SALES STEPS - follow in order:
Step 1: Products already selected (check cart above)
Step 2: Confirm selection
  - Ask: "You want [product name]? Confirm?"
  - Wait for YES before moving forward
Step 3: Ask size for each product
  - Ask: "What size do you need? S / M / L / XL / XXL"
  - Save size when given
Step 4: Ask quantity
  - Ask: "How many pieces do you need?"
  - Save quantity when given
Step 5: Ask full name
  - Ask: "What is your full name?"
  - Save name when given
Step 6: Ask delivery address
  - Ask: "Please share your delivery address."
  - Save address when given
Step 7: Show full order summary in this format:
  *Order Summary*
  Name: [name]
  Phone: [phone]
  Product: [name + color]
  Size: [size]
  Qty: [qty]
  Price: ₹[price] x [qty] = ₹[total]
  Delivery: ₹[charge]
  *Total: ₹[grand total]*
  Address: [address]
Step 8: Send payment details:
  Pay via GPay / PhonePe: *9998887776*
  Amount: ₹[total]
  After payment, please send the screenshot.
Step 9: After screenshot received
  - Confirm order with a simple order ID

LANGUAGE RULES:
- Default is simple English
- If customer writes Gujarati → reply in simple Gujarati
- If customer writes Hindi → reply in simple Hindi
- If customer writes mixed → match their mix
- Always understand poor spelling or grammar, focus on intent

IMPORTANT DATA TAGS - add at END of reply, customer won't see these:
- When customer gives name → add: updateName:[name]
- When size confirmed → add: updateSize:[code]:[size]
- When quantity confirmed → add: updateQty:[code]:[qty]
- When address confirmed → add: updateAddress:[address]

PRODUCTS AVAILABLE:
${JSON.stringify(products, null, 2)}

OFFERS:
- Buy 2 = 10% off
- Buy 3 = 20% off
- Delivery ₹99 on orders below ₹999
- Free delivery on orders ₹999 and above

IMPORTANT RULES:
- Stay focused on selling, ignore off-topic questions politely
- If customer seems confused, simplify your reply
- Never repeat the same question twice in a row
- Never send more than one question in one message`;

      // LOAD CONVERSATION HISTORY FROM DB
      const savedHistory =
        customer.conversationHistory || [];

      // Take last 25 messages only
      const historyToUse = savedHistory.slice(-25);

      // Add current user message
      historyToUse.push({
        role: 'user',
        parts: [{ text: userText }]
      });

      // GET GEMINI REPLY
      const aiReply = await getGeminiReply(
        historyToUse,
        systemPrompt
      );

      // PARSE AND SAVE DATA TAGS
      await parseAndSaveAIData(
        userPhone,
        aiReply,
        customer
      );

      // CLEAN REPLY - remove data tags before sending
      const cleanReply = aiReply
        .replace(/update\w+:[^\n]*/gi, '')
        .trim();

      // SAVE BOTH MESSAGES TO DB
      const updatedHistory = [
        ...savedHistory,
        { role: 'user', parts: [{ text: userText }] },
        { role: 'model', parts: [{ text: cleanReply }] }
      ];

      // Keep only last 25 messages in DB
      const trimmedHistory = updatedHistory.slice(-25);

      await updateCustomerSession(userPhone, {
        conversationHistory: trimmedHistory
      });

      // SEND REPLY TO CUSTOMER
      await sendTextMessage(userPhone, cleanReply);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.sendStatus(200);
  }
});

// GET OR CREATE CUSTOMER
async function getOrCreateCustomer(phone) {
  try {
    let customer = await Customer.findOne({ phone });

    if (!customer) {
      customer = new Customer({
        phone,
        session: { stage: 'new' }
      });
      await customer.save();
      console.log(`New customer: ${phone}`);
    } else {
      await Customer.findOneAndUpdate(
        { phone },
        {
          $inc: { totalVisits: 1 },
          $set: { lastVisit: new Date() }
        }
      );
      console.log(`Returning customer: ${phone}`);
    }
    return customer;
  } catch (error) {
    console.error('Customer error:', error.message);
    return null;
  }
}

// BUILD CUSTOMER CONTEXT FOR GEMINI
function buildCustomerContext(customer) {
  let context = '';

  if (customer.totalVisits > 1) {
    context += `Type: Returning customer\n`;
    context += `Total visits: ${customer.totalVisits}\n`;
  } else {
    context += `Type: New customer\n`;
  }

  if (customer.name) {
    context += `Name: ${customer.name}\n`;
  }

  context += `Phone: ${customer.phone}\n`;
  context += `Stage: ${customer.session.stage}\n`;

  if (customer.session.cart?.length > 0) {
    context += `\nCart:\n`;
    customer.session.cart.forEach(item => {
      context += `- ${item.code}: ${item.name} ${item.color}`;
      if (item.size) context += ` | Size: ${item.size}`;
      if (item.quantity) context += ` | Qty: ${item.quantity}`;
      context += ` | ₹${item.pricePerItem}\n`;
    });
  }

  if (customer.session.deliveryAddress) {
    context += `Address: ${customer.session.deliveryAddress}\n`;
  }

  if (customer.session.grandTotal > 0) {
    context += `Order total: ₹${customer.session.grandTotal}\n`;
  }

  if (customer.orders?.length > 0) {
    context += `\nPrevious orders: ${customer.orders.length}\n`;
    const lastOrder =
      customer.orders[customer.orders.length - 1];
    context += `Last order: ₹${lastOrder.grandTotal}`;
    context += ` - ${lastOrder.deliveryStatus}\n`;
  }

  return context;
}

// PARSE AI REPLY AND SAVE DATA TAGS
async function parseAndSaveAIData(phone, reply, customer) {
  try {
    const updates = {};

    // Extract name
    const nameMatch = reply.match(/updateName:([^\n]+)/i);
    if (nameMatch) {
      updates.name = nameMatch[1].trim();
      updates['session.stage'] = 'sizing';
    }

    // Extract size
    const sizeMatch = reply.match(/updateSize:(\w+):(\w+)/i);
    if (sizeMatch) {
      const code = sizeMatch[1].toUpperCase();
      const size = sizeMatch[2].toUpperCase();
      const cart = customer.session.cart.map(item => {
        if (item.code === code) item.size = size;
        return item;
      });
      updates['session.cart'] = cart;
      updates['session.stage'] = 'quantity';
    }

    // Extract quantity
    const qtyMatch = reply.match(/updateQty:(\w+):(\d+)/i);
    if (qtyMatch) {
      const code = qtyMatch[1].toUpperCase();
      const qty = parseInt(qtyMatch[2]);
      const cart = customer.session.cart.map(item => {
        if (item.code === code) {
          item.quantity = qty;
          item.totalPrice = item.pricePerItem * qty;
        }
        return item;
      });

      // Calculate totals with discount
      let orderTotal = cart.reduce(
        (sum, item) => sum + (item.totalPrice || 0), 0
      );
      const totalItems = cart.reduce(
        (sum, item) => sum + (item.quantity || 0), 0
      );

      // Apply offers
      if (totalItems >= 3) {
        orderTotal = Math.round(orderTotal * 0.8);
      } else if (totalItems >= 2) {
        orderTotal = Math.round(orderTotal * 0.9);
      }

      const deliveryCharge = orderTotal >= 999 ? 0 : 99;
      const grandTotal = orderTotal + deliveryCharge;

      updates['session.cart'] = cart;
      updates['session.orderTotal'] = orderTotal;
      updates['session.deliveryCharge'] = deliveryCharge;
      updates['session.grandTotal'] = grandTotal;
      updates['session.stage'] = 'address';
    }

    // Extract address
    const addressMatch = reply.match(
      /updateAddress:([^\n]+)/i
    );
    if (addressMatch) {
      updates['session.deliveryAddress'] =
        addressMatch[1].trim();
      updates['session.stage'] = 'payment';
    }

    if (Object.keys(updates).length > 0) {
      await updateCustomerSession(phone, updates);
      console.log(`DB updated:`, Object.keys(updates));
    }
  } catch (error) {
    console.error('Parse error:', error.message);
  }
}

// UPDATE CUSTOMER SESSION
async function updateCustomerSession(phone, data) {
  try {
    await Customer.findOneAndUpdate(
      { phone },
      { $set: data },
      { new: true }
    );
  } catch (error) {
    console.error('Update error:', error.message);
  }
}

// UPDATE CUSTOMER STAGE
async function updateCustomerStage(phone, stage) {
  await updateCustomerSession(phone, {
    'session.stage': stage
  });
}

// SEND ORDER SUMMARY
async function sendOrderSummary(phone, customer) {
  const cart = customer.session.cart;
  let summary = '*Your Selection*\n\n';

  cart.forEach(item => {
    summary += `- ${item.name} (${item.color})\n`;
    summary += `  Code: ${item.code} | ₹${item.pricePerItem}\n\n`;
  });

  summary += `Is this correct? Reply *Yes* to confirm.`;
  await sendTextMessage(phone, summary);
}

// SEND WELCOME BUTTONS
async function sendWelcomeButtons(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text:
              `Welcome to ${process.env.BUSINESS_NAME || 'Ashirwad Apparels'}!\n\n` +
              `Quality t-shirts at factory prices.\n` +
              `What would you like to do?`
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: {
                  id: 'view_collection',
                  title: 'View Collection'
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'todays_offers',
                  title: "Today's Offers"
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'talk_agent',
                  title: 'Talk to Agent'
                }
              }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('Welcome button error:', error.message);
  }
}

// SEND ALL PRODUCT IMAGES
async function sendAllProductImages(to) {
  await sendTextMessage(to,
    '*Our T-Shirt Collection*\n\n' +
    'Check all images below.\n' +
    'Send the *code* of the shirt you like.\n\n' +
    'Example: *TS01* or *TS01 TS03*'
  );

  for (const code in products) {
    const product = products[code];
    await sendImageMessage(
      to,
      product.image_url,
      product.caption
    );
    await delay(500);
  }

  await sendTextMessage(to,
    'Liked something? Just send the product code!\n' +
    'Example: *TS02* or *TS01 TS04*'
  );
}

// SEND TEXT MESSAGE
async function sendTextMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('Send text error:', error.message);
  }
}

// SEND IMAGE MESSAGE
async function sendImageMessage(to, imageUrl, caption) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'image',
        image: {
          link: imageUrl,
          caption: caption
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('Send image error:', error.message);
  }
}

// GEMINI AI
async function getGeminiReply(history, systemPrompt) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: history,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 500
        }
      }
    );
    return response.data.candidates[0]
      .content.parts[0].text;
  } catch (error) {
    console.error('Gemini error:', error.message);
    return "Sorry, something went wrong. Please try again in a moment.";
  }
}

// DETECT PRODUCT CODES IN MESSAGE
function detectProductCodes(text) {
  const upperText = text.toUpperCase();
  const foundCodes = [];

  for (const code in products) {
    if (upperText.includes(code)) {
      foundCodes.push(code);
    }
  }

  return foundCodes;
}

// DELAY HELPER
function delay(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `GlassChat server running on port ${PORT}`
  );
});
