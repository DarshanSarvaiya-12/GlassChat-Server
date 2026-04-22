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

app.get('/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

app.post('/settings/shipping', async (req, res) => {
  try {
    const { freeShipping, freeShippingAbove, shippingCharge } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      { $set: { freeShipping, freeShippingAbove, shippingCharge } },
      { new: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/settings/offers/add', async (req, res) => {
  try {
    const { title, description } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      { $push: { offers: { title, description, active: true } } },
      { new: true }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/settings/offers/update', async (req, res) => {
  try {
    const { offerId, title, description, active } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main', 'offers._id': offerId },
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

app.post('/settings/offers/delete', async (req, res) => {
  try {
    const { offerId } = req.body;
    await Settings.findOneAndUpdate(
      { singleton: 'main' },
      { $pull: { offers: { _id: offerId } } }
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

    // Get settings
    const settings = await getSettings();

    // Get or create customer
    let customer = await getOrCreateCustomer(userPhone);
    if (!customer) return res.sendStatus(200);

    // ── BUTTON TAP HANDLER ──
    if (messageType === 'interactive') {
      const buttonId = message.interactive?.button_reply?.id;
      console.log(`Button: ${buttonId}`);

      // SIZE BUTTONS
      if (['size_s','size_m','size_l',
           'size_xl','size_xxl'].includes(buttonId)) {
        const sizeMap = {
          size_s: 'S', size_m: 'M', size_l: 'L',
          size_xl: 'XL', size_xxl: 'XXL'
        };
        const selectedSize = sizeMap[buttonId];

        // Save selected size to session
        await updateCustomerSession(userPhone, {
          'session.selectedSize': selectedSize,
          'session.stage': 'browsing'
        });

        // Send all product images
        await sendAllProductImages(userPhone, selectedSize);
        return res.sendStatus(200);
      }

      // PAYMENT METHOD BUTTONS
      if (buttonId === 'pay_gpay' ||
          buttonId === 'pay_paytm') {
        await updateCustomerSession(userPhone, {
          'session.paymentMethod': 'online',
          'session.stage': 'payment'
        });
        await sendTextMessage(userPhone,
          "✅ *Payment Details:*\n\n" +
          "GPay / Paytm Number:\n" +
          `*${process.env.PAYMENT_NUMBER || '9999999999'}*\n\n` +
          "Please send the exact amount and " +
          "after payment send screenshot here! 📸"
        );
        return res.sendStatus(200);
      }

      if (buttonId === 'pay_cod') {
        await updateCustomerSession(userPhone, {
          'session.paymentMethod': 'cod',
          'session.stage': 'address'
        });
        await sendAddressRequest(userPhone);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // ── TEXT MESSAGE HANDLER ──
    if (messageType === 'text') {
      const userText = message.text.body.trim();
      console.log(`${userPhone}: ${userText}`);

      // Refresh customer
      customer = await Customer.findOne({ phone: userPhone });

      // ── NEW CUSTOMER ──
      if (customer.session.stage === 'new') {
        await sendWelcomeMessage(userPhone);
        return res.sendStatus(200);
      }

      // ── RETURNING CUSTOMER AFTER 10 MINUTES ──
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const isReturning = customer.totalVisits > 1 &&
        customer.lastMessageAt &&
        customer.lastMessageAt < tenMinutesAgo &&
        customer.session.stage !== 'new';

      if (isReturning && !customer.session.askedToContinue) {
        await updateCustomerSession(userPhone, {
          'session.askedToContinue': true
        });
        await sendTextMessage(userPhone,
          "👋 Welcome back!\n\n" +
          "Do you want to:\n\n" +
          "*1* - Continue previous conversation\n" +
          "*2* - Start new conversation"
        );
        // Update last message time
        await Customer.findOneAndUpdate(
          { phone: userPhone },
          { $set: { lastMessageAt: new Date() } }
        );
        return res.sendStatus(200);
      }

      // Handle continue/new choice
      if (customer.session.askedToContinue) {
        const lower = userText.toLowerCase();
        if (lower.includes('1') ||
            lower.includes('continue') ||
            lower.includes('previous')) {
          await updateCustomerSession(userPhone, {
            'session.askedToContinue': false
          });
          await sendTextMessage(userPhone,
            "Great! Let's continue where we left off! 😊"
          );
          // Continue to Groq with history
        } else if (lower.includes('2') ||
                   lower.includes('new')) {
          // Reset session
          await updateCustomerSession(userPhone, {
            'session.stage': 'new',
            'session.cart': [],
            'session.selectedSize': null,
            'session.conversationHistory': [],
            'session.askedToContinue': false,
            'session.deliveryAddress': null,
            'session.orderTotal': 0,
            'session.grandTotal': 0,
            'session.paymentMethod': null,
            'session.pendingConfirmation': false
          });
          await sendWelcomeMessage(userPhone);
          return res.sendStatus(200);
        }
      }

      // Update last message time
      await Customer.findOneAndUpdate(
        { phone: userPhone },
        { $set: { lastMessageAt: new Date() } }
      );

      // ── SIZE IN NUMBERS REQUEST ──
      const lowerText = userText.toLowerCase();
      if (lowerText.includes('size in number') ||
          lowerText.includes('size chart') ||
          lowerText.includes('size number') ||
          lowerText.includes('measurement') ||
          lowerText.includes('inch')) {
        await sendTextMessage(userPhone,
          "📏 *Size Chart:*\n\n" +
          "S  = 28 - 30 inches\n" +
          "M  = 30 - 32 inches\n" +
          "L  = 32 - 34 inches\n" +
          "XL = 34 - 36 inches\n\n" +
          "Which size would you like? 😊"
        );
        return res.sendStatus(200);
      }

      // ── DETECT PRODUCT CODE SELECTION ──
      const detectedCodes = detectProductCodes(userText);
      if (detectedCodes.length > 0 &&
          customer.session.stage === 'browsing') {

        const code = detectedCodes[0];
        const product = products[code];

        // Add to cart
        const existingCart = customer.session.cart || [];
        const newItem = {
          code: code,
          name: product.name,
          color: product.color,
          size: customer.session.selectedSize || 'M',
          pricePerItem: product.price,
          quantity: 1,
          totalPrice: product.price
        };
        existingCart.push(newItem);

        await updateCustomerSession(userPhone, {
          'session.cart': existingCart,
          'session.stage': 'confirmed'
        });

        customer = await Customer.findOne({ phone: userPhone });

        // Show selection confirmation
        await sendTextMessage(userPhone,
          `✅ *Nice Choice!*\n\n` +
          `You selected:\n` +
          `Code: *${product.code || code}*\n` +
          `Colour: *${product.color}*\n` +
          `Price: *₹${product.price}*\n\n` +
          `How many *${code}* do you want to buy?`
        );

        await updateCustomerSession(userPhone, {
          'session.stage': 'quantity',
          'session.pendingCode': code
        });

        return res.sendStatus(200);
      }

      // ── HANDLE QUANTITY INPUT ──
      if (customer.session.stage === 'quantity' &&
          customer.session.pendingCode) {
        const qty = parseInt(userText);
        if (!isNaN(qty) && qty > 0) {
          const code = customer.session.pendingCode;
          const cart = customer.session.cart.map(item => {
            if (item.code === code) {
              item.quantity = qty;
              item.totalPrice = item.pricePerItem * qty;
            }
            return item;
          });

          await updateCustomerSession(userPhone, {
            'session.cart': cart,
            'session.pendingCode': null,
            'session.stage': 'browsing'
          });

          // Ask for next t-shirt
          await sendTextMessage(userPhone,
            "Okay! Now would you like to select " +
            "another T-Shirt? 👕\n\n" +
            "Reply *Yes* to select more\n" +
            "Reply *No* if you are done"
          );
          return res.sendStatus(200);
        }
      }

      // ── HANDLE YES/NO FOR MORE ITEMS ──
      if (customer.session.stage === 'browsing' &&
          customer.session.cart?.length > 0) {
        const lower2 = userText.toLowerCase();

        if (lower2 === 'yes' || lower2 === 'y') {
          await sendTextMessage(userPhone,
            "Ok I'm waiting! 😊\n\n" +
            "Send the code of the T-Shirt " +
            "you want to add!"
          );
          return res.sendStatus(200);
        }

        if (lower2 === 'no' || lower2 === 'n' ||
            lower2.includes('done') ||
            lower2.includes('these') ||
            lower2.includes('that') ||
            lower2.includes('i want these') ||
            lower2.includes('finalize')) {
          await updateCustomerSession(userPhone, {
            'session.stage': 'confirmed'
          });
          customer = await Customer.findOne({ phone: userPhone });
          await sendFinalBill(userPhone, customer, settings);
          return res.sendStatus(200);
        }
      }

      // ── HANDLE ADDRESS SUBMISSION ──
      if (customer.session.stage === 'address') {
        // Check if message looks like an address
        if (userText.toUpperCase().includes('NAME') ||
            userText.toUpperCase().includes('HOUSE') ||
            userText.toUpperCase().includes('PINCODE') ||
            userText.length > 50) {

          await updateCustomerSession(userPhone, {
            'session.deliveryAddress': userText,
            'session.stage': 'confirming'
          });

          await sendTextMessage(userPhone, "Okay ✅");
          await delay(1000);
          await sendTextMessage(userPhone,
            "We will dispatch by Tomorrow and you " +
            "will receive your parcel within *5-7 Days*! 📦\n\n" +
            "Please send *OKAY* or *DONE* to confirm your order."
          );

          // Wait 2 minutes then remind if no confirmation
          setTimeout(async () => {
            const freshCustomer = await Customer.findOne(
              { phone: userPhone }
            );
            if (freshCustomer?.session?.stage === 'confirming') {
              await sendTextMessage(userPhone,
                "⚠️ Please send *OKAY* or *DONE* " +
                "to confirm your order!"
              );
            }
          }, 2 * 60 * 1000);

          return res.sendStatus(200);
        }
      }

      // ── HANDLE ORDER CONFIRMATION ──
      if (customer.session.stage === 'confirming') {
        const lower3 = userText.toLowerCase();
        if (lower3.includes('ok') ||
            lower3.includes('done') ||
            lower3.includes('confirm') ||
            lower3.includes('yes') ||
            lower3.includes('thank')) {

          await updateCustomerSession(userPhone, {
            'session.stage': 'completed'
          });

          await sendTextMessage(userPhone,
            "🎉 *Your Order is Confirmed!*"
          );
          await delay(500);
          await sendTextMessage(userPhone,
            "Thank you for Visiting! 😄\n\n" +
            "We hope to see you again soon! 🛍️"
          );
          return res.sendStatus(200);
        }
      }

      // ── HANDLE PAYMENT SCREENSHOT ──
      if (customer.session.stage === 'payment' &&
          customer.session.paymentMethod === 'online') {
        // Payment confirmed by customer text
        const lower4 = userText.toLowerCase();
        if (lower4.includes('done') ||
            lower4.includes('paid') ||
            lower4.includes('sent') ||
            lower4.includes('payment done') ||
            lower4.includes('screenshot')) {
          await updateCustomerSession(userPhone, {
            'session.stage': 'address'
          });

          customer = await Customer.findOne({ phone: userPhone });
          const grandTotal = customer.session.grandTotal || 0;

          await sendTextMessage(userPhone,
            `✅ Okay! We received your ` +
            `*₹${grandTotal}* payment!\n\n` +
            `Thank you! 🙏`
          );
          await delay(500);
          await sendAddressRequest(userPhone);
          return res.sendStatus(200);
        }
      }

      // ── GROQ AI HANDLES EVERYTHING ELSE ──
      customer = await Customer.findOne({ phone: userPhone });
      const customerContext = buildCustomerContext(customer);

      const systemPrompt =
`You are Niya, a friendly and professional sales assistant 
for Ashirwad Shop. You sell stylish T-Shirts.

CUSTOMER DATA:
${customerContext}

YOUR PERSONALITY:
- Warm, friendly, and helpful
- Speak only in simple English
- Use emojis naturally but not too much
- Keep very messages short and clear
- maintain enough gap between lines so read properly
- Never say you are an AI
- Ask only one question at a time
- Be patient and understanding

PRODUCTS AVAILABLE:
${JSON.stringify(products)}

CURRENT OFFERS:
- Buy 2 T-Shirts = 10% discount
- Buy 3 or more = 20% discount

SHIPPING:
- Delivery charge: 99 rupees
- Free delivery above 999 rupees

PAYMENT OPTIONS:
- GPay / Paytm
- Cash on Delivery (COD)

Shipping Address:
- use this format 
NAME - 
HOUSE NO - 
ADDRESS - 
LANDMARK -  
CITY - 
PINCODE - 
DISTRICT -
STATE - 
PHONE NO.-
(check full address details are filled)

Okay,We get your address but if we found any mistakes in your address than we will contact you again in 24h.

Ending:
- send full Bill again with payment information,Date and time
- than say We Dispatch by tomorrow and you will receive your Parcel within 7 days

Confirmation:
- ask customer, Order Confirm ?
- if order confirm than send Thank you for Visiting 😄 

YOUR KNOWLEDGE:
Size Chart:
S  = 28-30 inches
M  = 30-32 inches  
L  = 32-34 inches
XL = 34-36 inches

IMPORTANT RULES:
- Always be helpful and guide customer step by step
- If customer asks about size in numbers, share the size chart
- If customer seems confused, gently guide them
- Never share competitor information
- If customer is rude, stay calm and professional
- Always confirm details before finalizing order

YOUR JOB:
Help customer complete their purchase naturally.
The main flow is handled by the system automatically.
Your job is to answer questions, handle confusion,
and keep the conversation moving smoothly toward a sale.`;

      const recentHistory =
        customer.session.conversationHistory || [];

      recentHistory.push({
        role: 'user',
        parts: [{ text: userText }]
      });

      const aiReply = await getGroqReply(
        recentHistory,
        systemPrompt
      );

      // Clean reply
      const cleanReply = aiReply
        .replace(/update\w+:[^\n]*/gi, '')
        .trim();

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

    // ── IMAGE MESSAGE HANDLER ──
    // Customer sends payment screenshot
    if (messageType === 'image') {
      const customer2 = await Customer.findOne({
        phone: userPhone
      });

      if (customer2?.session?.stage === 'payment' &&
          customer2?.session?.paymentMethod === 'online') {

        const grandTotal = customer2.session.grandTotal || 0;

        await updateCustomerSession(userPhone, {
          'session.stage': 'address'
        });

        await sendTextMessage(userPhone,
          `✅ Okay! We received your ` +
          `*₹${grandTotal}* payment!\n\n` +
          `Thank you! 🙏`
        );
        await delay(500);
        await sendAddressRequest(userPhone);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error.message);
    res.sendStatus(200);
  }
});

// ─────────────────────────────────────
// FLOW FUNCTIONS
// ─────────────────────────────────────

// SEND WELCOME MESSAGE + SIZE BUTTONS
async function sendWelcomeMessage(to) {
  // First send welcome text
  await sendTextMessage(to,
    "Welcome to *Ashirwad Shop*! 👕\n\n" +
    "Buy stylish T-Shirts from us!"
  );

  await delay(500);

  // Then send size buttons
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
            text: "Please select your Size: 👇"
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: { id: 'size_s', title: 'S' }
              },
              {
                type: 'reply',
                reply: { id: 'size_m', title: 'M' }
              },
              {
                type: 'reply',
                reply: { id: 'size_l', title: 'L' }
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

    await delay(500);

    // Send XL and XXL as second button message
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: "More sizes:"
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: { id: 'size_xl', title: 'XL' }
              },
              {
                type: 'reply',
                reply: { id: 'size_xxl', title: 'XXL' }
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

    // Update stage
    await updateCustomerSession(to, {
      'session.stage': 'browsing'
    });

  } catch (error) {
    console.error('Welcome button error:', error.message);
  }
}

// SEND ALL PRODUCT IMAGES WITH CODE/COLOUR/PRICE
async function sendAllProductImages(to, size) {
  await sendTextMessage(to,
    `Great! You selected Size *${size}* 👍\n\n` +
    `Here is our T-Shirt Collection 👇`
  );

  await delay(300);

  for (const code in products) {
    const product = products[code];
    const caption =
      `Code: ${code}\n` +
      `Colour: ${product.color}\n` +
      `Price: ₹${product.price}`;

    await sendImageMessage(to, product.image_url, caption);
    await delay(600);
  }

  await delay(500);
  await sendTextMessage(to,
    "⬆️ Send the *Code* of the T-Shirt " +
    "which you want to buy!\n\n" +
    "Example: *TS01*"
  );
}

// SEND FINAL BILL
async function sendFinalBill(phone, customer, settings) {
  const cart = customer.session.cart || [];

  if (cart.length === 0) {
    await sendTextMessage(phone,
      "No items in cart. Please select a T-Shirt first!"
    );
    return;
  }

  // Calculate totals
  let orderTotal = 0;
  cart.forEach(item => {
    orderTotal += item.totalPrice || item.pricePerItem;
  });

  // Apply discounts
  let discount = 0;
  if (cart.length === 2) discount = orderTotal * 0.10;
  if (cart.length >= 3) discount = orderTotal * 0.20;
  const discountedTotal = orderTotal - discount;

  // Shipping
  let shippingCost = 99;
  if (settings?.freeShipping) {
    shippingCost = 0;
  } else if (discountedTotal >= (settings?.freeShippingAbove || 999)) {
    shippingCost = 0;
  }

  const grandTotal = discountedTotal + shippingCost;

  // Save totals
  await updateCustomerSession(phone, {
    'session.orderTotal': discountedTotal,
    'session.deliveryCharge': shippingCost,
    'session.grandTotal': grandTotal,
    'session.stage': 'confirmed'
  });

  // Build bill
  let bill = "🧾 *Your Order Bill:*\n";
  bill += "─────────────────\n\n";

  cart.forEach((item, index) => {
    bill += `*T-Shirt ${index + 1}:*\n`;
    bill += `Code     : ${item.code}\n`;
    bill += `Size     : ${item.size}\n`;
    bill += `Colour   : ${item.color}\n`;
    bill += `Quantity : ${item.quantity}\n`;
    bill += `Price    : ₹${item.totalPrice || item.pricePerItem}\n`;
    bill += `\n`;
  });

  bill += `─────────────────\n`;

  if (discount > 0) {
    bill += `Original  : ₹${orderTotal}\n`;
    bill += `Discount  : -₹${discount.toFixed(0)}\n`;
  }

  bill += `Total Price  : ₹${discountedTotal.toFixed(0)}\n`;
  bill += `Shipping Cost: ${shippingCost === 0 ? 'FREE 🎉' : '₹' + shippingCost}\n`;
  bill += `─────────────────\n`;
  bill += `*Grand Total : ₹${grandTotal.toFixed(0)}*\n`;
  bill += `─────────────────`;

  await sendTextMessage(phone, bill);
  await delay(800);

  // Ask payment method
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: "How will you make Payment? 💳"
          },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: { id: 'pay_gpay', title: '💳 GPay/Paytm' }
              },
              {
                type: 'reply',
                reply: { id: 'pay_cod', title: '💵 Cash on Delivery' }
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
    console.error('Payment button error:', error.message);
  }
}

// SEND ADDRESS REQUEST
async function sendAddressRequest(phone) {
  await sendTextMessage(phone,
    "📦 Please send your *Shipping Address* " +
    "in this format:\n\n" +
    "NAME -\n" +
    "HOUSE NO -\n" +
    "ADDRESS -\n" +
    "LANDMARK -\n" +
    "CITY -\n" +
    "PINCODE -\n" +
    "DISTRICT -\n" +
    "STATE -\n" +
    "PHONE NO -"
  );
}

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
        session: { stage: 'new' },
        lastMessageAt: new Date()
      });
      await customer.save();
      console.log(`New customer: ${phone}`);
    } else {
      await Customer.findOneAndUpdate(
        { phone },
        { $inc: { totalVisits: 1 } }
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
    context += `Total Visits: ${customer.totalVisits}\n`;
  } else {
    context += `NEW CUSTOMER\n`;
  }

  if (customer.name) {
    context += `Name: ${customer.name}\n`;
  }

  context += `Phone: ${customer.phone}\n`;
  context += `Current Stage: ${customer.session.stage}\n`;

  if (customer.session.selectedSize) {
    context += `Selected Size: ${customer.session.selectedSize}\n`;
  }

  if (customer.session.cart?.length > 0) {
    context += `\nCURRENT CART (${customer.session.cart.length} items):\n`;
    customer.session.cart.forEach(item => {
      context += `- ${item.code}: ${item.name} `;
      context += `${item.color} Size:${item.size} `;
      context += `Qty:${item.quantity} `;
      context += `₹${item.totalPrice}\n`;
    });
    context += `Order Total: ₹${customer.session.orderTotal}\n`;
    context += `Grand Total: ₹${customer.session.grandTotal}\n`;
  }

  if (customer.session.deliveryAddress) {
    context += `\nDelivery Address:\n`;
    context += `${customer.session.deliveryAddress}\n`;
  }

  if (customer.orders?.length > 0) {
    context += `\nPREVIOUS ORDERS: `;
    context += `${customer.orders.length} past orders\n`;
  }

  return context;
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
async function getGroqReply(history, systemPrompt) {
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
        role: msg.role === 'model' ? 'assistant' : 'user',
        content: text
      });
    });

    console.log('Sending to Groq:', messages.length, 'messages');

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

    return response.data.choices[0].message.content;

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
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GlassChat server running on port ${PORT}`);
});