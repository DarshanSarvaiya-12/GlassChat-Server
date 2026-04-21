require('dotenv').config();
const express = require('express');
const axios = require('axios');
const products = require('./products');
const { connectDB, Customer, Settings, getSettings } = require('./db');

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

// ─────────────────────────────────────
// SETTINGS API FOR WEBSITE
// ─────────────────────────────────────

// Get all settings
app.get('/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update business info
app.post('/settings/business', async (req, res) => {
  try {
    const { businessName, businessCity } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      { $set: { businessName, businessCity } },
      { new: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update system prompt
app.post('/settings/prompt', async (req, res) => {
  try {
    const { systemPrompt } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      { $set: { systemPrompt } },
      { new: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update shipping
app.post('/settings/shipping', async (req, res) => {
  try {
    const {
      freeShipping,
      freeShippingAbove,
      shippingCharge
    } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      {
        $set: {
          freeShipping,
          freeShippingAbove,
          shippingCharge
        }
      },
      { new: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add offer
app.post('/settings/offers/add', async (req, res) => {
  try {
    const { title, description } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      {
        $push: {
          offers: { title, description, active: true }
        }
      },
      { new: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update offer
app.post('/settings/offers/update', async (req, res) => {
  try {
    const { offerId, title, description, active } = req.body;
    await Settings.findOneAndUpdate(
      {
        singleton: 'main',
        'offers._id': offerId
      },
      {
        $set: {
          'offers.$.title': title,
          'offers.$.description': description,
          'offers.$.active': active
        }
      }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete offer
app.post('/settings/offers/delete', async (req, res) => {
  try {
    const { offerId } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      {
        $pull: {
          offers: { _id: offerId }
        }
      }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────
// WHATSAPP WEBHOOK
// ─────────────────────────────────────

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const userPhone = message.from;
    const messageType = message.type;

    // Get settings from DB
    const settings = await getSettings();

    // Get or create customer
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
        // Build offers from DB
        const activeOffers = settings.offers.filter(
          o => o.active
        );
        let offersText = "🔥 *Today's Special Offers!*\n\n";
        if (activeOffers.length > 0) {
          activeOffers.forEach(offer => {
            offersText += `✅ ${offer.title}\n`;
            offersText += `${offer.description}\n\n`;
          });
        } else {
          offersText +=
            "✅ Buy 2 = 10% OFF\n" +
            "✅ Buy 3 = 20% OFF\n" +
            "✅ Free delivery above " +
            `${settings.freeShippingAbove} rupees\n\n`;
        }
        offersText += "Tap below to view collection!";
        await sendTextMessage(userPhone, offersText);
        await sendWelcomeButtons(userPhone, settings);

      } else if (buttonId === 'talk_agent') {
        await sendTextMessage(userPhone,
          "👤 *Agent Support*\n\n" +
          "Our agent is available 9AM to 6PM.\n\n" +
          "Meanwhile view our collection!"
        );
        await sendWelcomeButtons(userPhone, settings);
      }
      return res.sendStatus(200);
    }

    // TEXT MESSAGE HANDLER
    if (messageType === 'text') {
      const userText = message.text.body.trim();
      console.log(`${userPhone}: ${userText}`);

      // NEW CUSTOMER
      if (customer.session.stage === 'new') {
        await sendWelcomeButtons(userPhone, settings);
        return res.sendStatus(200);
      }

      // DETECT PRODUCT CODES
      const detectedCodes = detectProductCodes(userText);

      if (detectedCodes.length > 0 &&
        customer.session.stage === 'browsing') {
        await updateCustomerSession(userPhone, {
          'session.stage': 'confirmed',
          'session.cart': detectedCodes.map(code => ({
            code: code,
            name: products[code].name,
            color: products[code].color,
            pricePerItem: products[code].price,
          }))
        });

        customer = await Customer.findOne({
          phone: userPhone
        });

        await sendOrderSummary(
          userPhone,
          customer,
          settings
        );
        return res.sendStatus(200);
      }

      // GEMINI/GROQ HANDLES CONVERSATION
      customer = await Customer.findOne({
        phone: userPhone
      });

      const customerContext =
        buildCustomerContext(customer);

      // Build offers text for prompt
      const activeOffers = settings.offers.filter(
        o => o.active
      );
      let offersPromptText = '';
      if (activeOffers.length > 0) {
        activeOffers.forEach(offer => {
          offersPromptText +=
            `${offer.title}: ${offer.description}\n`;
        });
      } else {
        offersPromptText =
          'Buy 2 get 10 percent off\n' +
          'Buy 3 get 20 percent off';
      }

      // Shipping text for prompt
      const shippingText = settings.freeShipping
        ? 'All orders have FREE shipping'
        : `Free shipping above ${settings.freeShippingAbove} rupees. ` +
          `Charge: ${settings.shippingCharge} rupees below that.`;

      // Use custom prompt from DB or default
      const customPrompt = settings.systemPrompt || '';

      const systemPrompt =
`You are Alex, a friendly sales assistant for
${settings.businessName} in ${settings.businessCity}.

${customPrompt}

CUSTOMER DATA:
${customerContext}

YOUR PERSONALITY:
- Friendly and professional
- Speak only in simple English
- Use emojis naturally
- Keep messages short
- Never say you are AI
- Ask one question at a time
- Never mention competitor shops

IMPORTANT - PRODUCT PHOTOS:
If customer asks to see products, photos,
collection, images, or anything related to
viewing products - reply with exactly this
one word only on first line: SENDPHOTOS
Then continue your message normally.

YOUR JOB - Follow these steps strictly:
Step 1: Customer selects products (already done)
Step 2: Confirm their selection warmly
        Example: "You want TS02 Red T-Shirt right?"
        Wait for YES before moving forward
Step 3: After YES - Ask size for each product
        "What size do you need? S/M/L/XL/XXL"
Step 4: Ask quantity
        "How many pieces do you need?"
Step 5: Ask full name
        "May I know your full name please?"
Step 6: Ask delivery address
        "Please share your delivery address"
Step 7: Show complete order summary in this
        exact format:

        Name: [name]
        Contact: [phone]
        Products: [list]
        Sizes: [sizes]
        Colors: [colors]

        Each Price: [price per item x quantity]
        Total Price: [total without delivery]

        Address: [address]

        Delivery: [charge]

        Total: [grand total]

Step 8: Send payment details:
        "Please pay using GPay or PhonePe:
        Number: 9998887776
        Amount: [total]
        After payment please send screenshot!"
Step 9: After payment screenshot confirm order:
        "Order confirmed!
        Your Order ID is ORD-XXXX
        Delivery in 3 to 5 days!"

IMPORTANT TAGS:
Add at END of reply. Customer will NOT see these.
- After name given: updateName:[name]
- After size confirmed: updateSize:[code]:[size]
- After quantity confirmed: updateQty:[code]:[qty]
- After address confirmed: updateAddress:[address]

PRODUCTS: ${JSON.stringify(products)}
OFFERS:
${offersPromptText}
SHIPPING: ${shippingText}`;

      // Get conversation history
      const recentHistory =
        customer.session.conversationHistory || [];

      recentHistory.push({
        role: 'user',
        parts: [{ text: userText }]
      });

      const aiReply = await getAIReply(
        recentHistory,
        systemPrompt
      );

      // Check if AI wants to send photos
      if (aiReply.startsWith('SENDPHOTOS')) {
        await updateCustomerStage(
          userPhone, 'browsing'
        );
        await sendAllProductImages(userPhone);

        // Clean SENDPHOTOS from reply
        const cleanedReply = aiReply
          .replace('SENDPHOTOS', '')
          .trim();

        if (cleanedReply.length > 0) {
          await sendTextMessage(userPhone, cleanedReply);
        }

        // Save to history
        recentHistory.push({
          role: 'model',
          parts: [{ text: aiReply }]
        });
        const trimmedHistory =
          recentHistory.slice(-50);
        await updateCustomerSession(userPhone, {
          'session.conversationHistory': trimmedHistory
        });

        return res.sendStatus(200);
      }

      // Parse and save data tags
      await parseAndSaveAIData(
        userPhone,
        aiReply,
        customer
      );

      // Clean reply
      const cleanReply = aiReply
        .replace(/update\w+:[^\n]*/gi, '')
        .trim();

      // Save conversation
      recentHistory.push({
        role: 'model',
        parts: [{ text: cleanReply }]
      });

      // Keep last 50 messages = 25 exchanges
      const trimmedHistory = recentHistory.slice(-50);

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

// ─────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────

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

// BUILD CUSTOMER CONTEXT FOR AI
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
      if (item.size) {
        context += ` Size: ${item.size}`;
      }
      if (item.quantity) {
        context += ` Qty: ${item.quantity}`;
      }
      context += ` Price: ${item.pricePerItem}\n`;
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
    context += `Last order: ${lastOrder.grandTotal}`;
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

    const nameMatch = reply.match(
      /updateName:([^\n]+)/i
    );
    if (nameMatch) {
      updates.name = nameMatch[1].trim();
      updates['session.stage'] = 'address';
    }

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
      updates['session.stage'] = 'sizing';
    }

    const qtyMatch = reply.match(
      /updateQty:(\w+):(\d+)/i
    );
    if (qtyMatch) {
      const code = qtyMatch[1];
      const qty = parseInt(qtyMatch[2]);
      const settings = await getSettings();
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

      let deliveryCharge = settings.shippingCharge;
      if (settings.freeShipping) {
        deliveryCharge = 0;
      } else if (orderTotal >= settings.freeShippingAbove) {
        deliveryCharge = 0;
      }

      const grandTotal = orderTotal + deliveryCharge;

      updates['session.cart'] = cart;
      updates['session.orderTotal'] = orderTotal;
      updates['session.deliveryCharge'] = deliveryCharge;
      updates['session.grandTotal'] = grandTotal;
      updates['session.stage'] = 'quantity';
    }

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
async function sendOrderSummary(
  phone, customer, settings
) {
  const cart = customer.session.cart;

  let orderTotal = 0;
  cart.forEach(item => {
    orderTotal += item.pricePerItem;
  });

  let deliveryCharge = settings.shippingCharge;
  if (settings.freeShipping) {
    deliveryCharge = 0;
  } else if (orderTotal >= settings.freeShippingAbove) {
    deliveryCharge = 0;
  }

  const grandTotal = orderTotal + deliveryCharge;

  let summary =
    "🛒 *Please Confirm Your Selection:*\n\n";

  cart.forEach(item => {
    summary += `✅ ${item.name}\n`;
    summary += `   Color: ${item.color}\n`;
    summary += `   Price: ${item.pricePerItem}\n\n`;
  });

  summary += `──────────────────\n`;
  summary += `Total Price: ${orderTotal}\n`;
  summary += `Delivery: ${deliveryCharge === 0 
    ? 'FREE' 
    : deliveryCharge + ' rupees'}\n`;
  summary += `Grand Total: ${grandTotal}\n`;
  summary += `──────────────────\n\n`;
  summary += `Is this selection correct? `;
  summary += `Please reply Yes or No`;

  await sendTextMessage(phone, summary);
}

// SEND WELCOME BUTTONS
async function sendWelcomeButtons(to, settings) {
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
            text: `Welcome to ${settings.businessName}! 👕\n\nBest quality t-shirts at factory price!\n${settings.freeShipping 
              ? 'FREE delivery on all orders! 🎉' 
              : `Free delivery above ${settings.freeShippingAbove} rupees! 🔥`}`
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
                  title: '💰 Todays Offers'
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
    "👕 *Our T-Shirt Collection*\n\n" +
    "Check all images below and send " +
    "the product code you like!\n\n" +
    "Example: *TS01* or *TS01 TS03*"
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
    "⬆️ Liked something?\n\n" +
    "Just send the product code!\n" +
    "Example: *TS01* or *TS01 TS03*\n\n" +
    "Our assistant will help you " +
    "complete your order! 😊"
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

// GROQ AI
async function getAIReply(history, systemPrompt) {
  try {
    const messages = [];

    messages.push({
      role: 'system',
      content: systemPrompt
    });

    history.forEach(msg => {
      if (!msg || !msg.parts || !msg.parts[0]) return;
      const text = msg.parts[0].text;
      if (!text || text.trim() === '') return;

      messages.push({
        role: msg.role === 'model'
          ? 'assistant'
          : 'user',
        content: text
      });
    });

    console.log('Sending to Groq:',
      messages.length, 'messages');

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        max_tokens: 500,
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.choices[0]
      .message.content;

  } catch (error) {
    console.error('Groq error:', error.message);
    if (error.response) {
      console.error('Groq details:',
        JSON.stringify(error.response.data));
    }
    return "Sorry, please try again in a moment!";
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