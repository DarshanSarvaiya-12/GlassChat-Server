require('dotenv').config();
const express = require('express');
const axios = require('axios');
const products = require('./products');
const { connectDB, Customer } = require('./db');

const app = express();
app.use(express.json());

// Connect MongoDB
connectDB();

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

    const userPhone = message.from;
    const messageType = message.type;

    // Get or create customer from MongoDB
    let customer = await getOrCreateCustomer(userPhone);

    if (!customer) return res.sendStatus(200);

    // BUTTON TAP HANDLER
    if (messageType === 'interactive') {
      const buttonId =
        message.interactive?.button_reply?.id;
      console.log(`Button: ${buttonId}`);

      if (buttonId === 'view_collection') {
        await updateCustomerStage(
          userPhone, 'browsing'
        );
        await sendAllProductImages(userPhone);

      } else if (buttonId === 'todays_offers') {
        await sendTextMessage(userPhone,
          "🔥 *Aaj na Special Offers!*\n\n" +
          "✅ Buy 2 = 10% OFF\n" +
          "✅ Buy 3 = 20% OFF\n" +
          "✅ Free delivery above ₹999\n\n" +
          "Collection jova maate 👇"
        );
        await sendWelcomeButtons(userPhone);

      } else if (buttonId === 'talk_agent') {
        await sendTextMessage(userPhone,
          "👤 *Agent Support*\n\n" +
          "Amaro agent 9AM-6PM available che.\n\n" +
          "Tyaa sudhi collection joi shakho! 👇"
        );
        await sendWelcomeButtons(userPhone);
      }
      return res.sendStatus(200);
    }

    // TEXT MESSAGE HANDLER
    if (messageType === 'text') {
      const userText = message.text.body.trim();
      console.log(`${userPhone}: ${userText}`);

      // NEW CUSTOMER
      if (customer.session.stage === 'new') {
        await sendWelcomeButtons(userPhone);
        return res.sendStatus(200);
      }

      // DETECT PRODUCT CODES
      const detectedCodes = detectProductCodes(userText);

      if (detectedCodes.length > 0 &&
        customer.session.stage === 'browsing') {

        // Save selected products to DB
        await updateCustomerSession(userPhone, {
          'session.stage': 'confirmed',
          'session.cart': detectedCodes.map(code => ({
            code: code,
            name: products[code].name,
            color: products[code].color,
            pricePerItem: products[code].price,
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
      customer = await Customer.findOne({
        phone: userPhone
      });

      const customerContext =
        buildCustomerContext(customer);

      const systemPrompt =
`You are Priya, friendly sales assistant for 
${process.env.BUSINESS_NAME} in 
${process.env.BUSINESS_CITY}.

CUSTOMER DATA:
${customerContext}

YOUR PERSONALITY:
- Friendly and professional
- Speak Gujarati + English mixed
- Use emojis naturally
- Keep messages short
- Never say you are AI
- One question at a time

YOUR JOB - Follow steps strictly:
Step 1: Customer selects products (already done)
Step 2: Confirm selection warmly
        "TS02 Red T-Shirt leva che ne?"
        Wait for YES before moving forward
Step 3: After YES - Ask size for each product
        "Kon sa size joie? S/M/L/XL/XXL"
        Save size immediately when given
Step 4: Ask quantity
        "Ketla joie che?"
        Save quantity immediately
Step 5: Ask full name
        "Tamaru full name shun che?"
        Save name immediately
Step 6: Ask delivery address
        "Delivery address apo please"
        Save address immediately
Step 7: Show complete order summary:
        Name: [name]
        Contact: [phone]
        Products: [list]
        Sizes: [sizes]
        Colors: [colors]
        Price: [breakdown]
        Address: [address]
        Total: ₹[amount]
Step 8: Send payment details:
        GPay/PhonePe: 9998887776
        Amount: ₹[total]
        Payment karya pachi screenshot moklo!
Step 9: After payment screenshot received
        Confirm order with order ID

IMPORTANT TAGS - Add at END of reply:
- After name given: updateName:[name]
- After size confirmed: updateSize:[code]:[size]
- After quantity confirmed: updateQty:[code]:[qty]
- After address confirmed: updateAddress:[address]
These tags save data to database automatically.
Customer will NOT see these tags.

PRODUCTS: ${JSON.stringify(products)}
OFFERS: Buy 2=10% off, Buy 3=20% off
DELIVERY: ₹99 below ₹999, FREE above ₹999`;

      // Get conversation history from DB
      const recentHistory =
        customer.session.conversationHistory || [];

      recentHistory.push({
        role: 'user',
        parts: [{ text: userText }]
      });

      const aiReply = await getGeminiReply(
        recentHistory,
        systemPrompt
      );

      // Parse and save data tags from AI reply
      await parseAndSaveAIData(
        userPhone,
        aiReply,
        customer
      );

      // Clean reply before sending to customer
      const cleanReply = aiReply
        .replace(/update\w+:[^\n]*/gi, '')
        .trim();

      // Save conversation to DB
      recentHistory.push({
        role: 'model',
        parts: [{ text: cleanReply }]
      });

      // Keep only last 20 messages
      const trimmedHistory = recentHistory.slice(-20);

      await updateCustomerSession(userPhone, {
        'session.conversationHistory': trimmedHistory
      });

      await sendTextMessage(userPhone, cleanReply);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error.message);
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
      console.log(`Returning: ${phone}`);
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
    context += `RETURNING CUSTOMER\n`;
    context += `Visits: ${customer.totalVisits}\n`;
  } else {
    context += `NEW CUSTOMER\n`;
  }

  if (customer.name) {
    context += `Name: ${customer.name}\n`;
  }

  context += `Phone: ${customer.phone}\n`;
  context += `Stage: ${customer.session.stage}\n`;

  if (customer.session.cart?.length > 0) {
    context += `\nCURRENT CART:\n`;
    customer.session.cart.forEach(item => {
      context += `- ${item.code}: ${item.name}`;
      context += ` ${item.color}`;
      if (item.size) context += ` Size:${item.size}`;
      if (item.quantity) {
        context += ` Qty:${item.quantity}`;
      }
      context += ` ₹${item.pricePerItem}\n`;
    });
  }

  if (customer.session.deliveryAddress) {
    context += `Address: `;
    context += `${customer.session.deliveryAddress}\n`;
  }

  if (customer.orders?.length > 0) {
    context += `\nPREVIOUS ORDERS: `;
    context += `${customer.orders.length} orders\n`;
    const lastOrder =
      customer.orders[customer.orders.length - 1];
    context += `Last: ₹${lastOrder.grandTotal}`;
    context += ` - ${lastOrder.deliveryStatus}\n`;
  }

  return context;
}

// PARSE AI REPLY AND SAVE DATA TAGS
async function parseAndSaveAIData(
  phone, reply, customer
) {
  try {
    const updates = {};

    // Extract name
    const nameMatch = reply.match(
      /updateName:([^\n]+)/i
    );
    if (nameMatch) {
      updates.name = nameMatch[1].trim();
      updates['session.stage'] = 'address';
    }

    // Extract size
    const sizeMatch = reply.match(
      /updateSize:(\w+):(\w+)/i
    );
    if (sizeMatch) {
      const code = sizeMatch[1];
      const size = sizeMatch[2];
      const cart = customer.session.cart.map(item => {
        if (item.code === code) item.size = size;
        return item;
      });
      updates['session.cart'] = cart;
      updates['session.stage'] = 'quantity';
    }

    // Extract quantity
    const qtyMatch = reply.match(
      /updateQty:(\w+):(\d+)/i
    );
    if (qtyMatch) {
      const code = qtyMatch[1];
      const qty = parseInt(qtyMatch[2]);
      const cart = customer.session.cart.map(item => {
        if (item.code === code) {
          item.quantity = qty;
          item.totalPrice = item.pricePerItem * qty;
        }
        return item;
      });

      const orderTotal = cart.reduce(
        (sum, item) => sum + (item.totalPrice || 0), 0
      );
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
      console.log(`DB saved:`, updates);
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

// SEND ORDER SUMMARY
async function sendOrderSummary(phone, customer) {
  const cart = customer.session.cart;
  let summary =
    "🛒 *Tamari Selection Confirm Karo:*\n\n";

  cart.forEach(item => {
    summary += `✅ ${item.name}\n`;
    summary += `   Color: ${item.color}\n`;
    summary += `   Price: ₹${item.pricePerItem}\n\n`;
  });

  summary += `Aa selection sahi che ne? (Yes/No)`;
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
            text: `Welcome to ${process.env.BUSINESS_NAME}! 👕\n\nGujarat ni best quality t-shirts\nSurat thi direct factory price! 🔥`
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: {
                  id: 'view_collection',
                  title: '🛍️ View Collection'
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'todays_offers',
                  title: '💰 Today\'s Offers'
                }
              },
              {
                type: 'reply',
                reply: {
                  id: 'talk_agent',
                  title: '📞 Talk to Agent'
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
    console.error('Button error:', error.message);
  }
}

// SEND ALL PRODUCT IMAGES
async function sendAllProductImages(to) {
  await sendTextMessage(to,
    "👕 *Amari T-Shirt Collection*\n\n" +
    "Badhi images juo ane pasand aave " +
    "te no *code* moklo!\n\nExample: *TS01 TS03*"
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
    "⬆️ Collection joi lidhu?\n\n" +
    "Hava *product code* moklo!\n" +
    "Example: *TS01* ya *TS01 TS03*\n\n" +
    "Amaro AI assistant thamari madad karse! 😊"
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
    console.error('Send error:', error.message);
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
    console.error('Image error:', error.message);
  }
}

// GEMINI AI
async function getGeminiReply(history, systemPrompt) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: history
      }
    );
    return response.data.candidates[0]
      .content.parts[0].text;
  } catch (error) {
    console.error('Gemini error:', error.message);
    return "Sorry, thodi var pachi try karo! 🙏";
  }
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