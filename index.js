require('dotenv').config();
const express = require('express');
const axios = require('axios');
const products = require('./products');
const { connectDB, Customer } = require('./db');

const app = express();
app.use(express.json());

// Connect MongoDB
connectDB();

// ====================== HEALTH CHECK ======================
app.get('/', (req, res) => {
  res.status(200).send('GlassChat server is running!');
});

// ====================== WEBHOOK VERIFICATION ======================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ====================== MAIN WEBHOOK ======================
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const userPhone = message.from;
    const messageType = message.type;

    let customer = await getOrCreateCustomer(userPhone);
    if (!customer) return res.sendStatus(200);

    await Customer.findOneAndUpdate({ phone: userPhone }, { lastMessageAt: new Date() });

    // Button Handler
    if (messageType === 'interactive') {
      const buttonId = message.interactive?.button_reply?.id;
      console.log(`Button: ${buttonId}`);

      if (['size_s', 'size_m', 'size_l', 'size_xl', 'size_xxl'].includes(buttonId)) {
        const sizeMap = { size_s: 'S', size_m: 'M', size_l: 'L', size_xl: 'XL', size_xxl: 'XXL' };
        await updateCustomerSession(userPhone, {
          'session.selectedSize': sizeMap[buttonId],
          'session.stage': 'browsing',
          'session.cart': []
        });
        await sendAllProductImages(userPhone, sizeMap[buttonId]);
        return res.sendStatus(200);
      }

      if (['pay_gpay', 'pay_paytm', 'pay_cod'].includes(buttonId)) {
        customer = await Customer.findOne({ phone: userPhone });
        if (customer.session.paymentMethod) {
          await sendTextMessage(userPhone, "⚠️ Payment method already selected.");
          return res.sendStatus(200);
        }

        const grandTotal = customer.session.grandTotal || 0;

        if (buttonId === 'pay_gpay' || buttonId === 'pay_paytm') {
          await updateCustomerSession(userPhone, {
            'session.paymentMethod': 'online',
            'session.stage': 'payment',
            'session.paymentAmount': grandTotal
          });
          await sendTextMessage(userPhone, `✅ *Payment Details:*\n\nGPay/Paytm: *\( {process.env.PAYMENT_NUMBER || '9999999999'}*\nAmount: *₹ \){grandTotal}*\n\nSend screenshot after payment!`);
        } else if (buttonId === 'pay_cod') {
          await updateCustomerSession(userPhone, {
            'session.paymentMethod': 'cod',
            'session.stage': 'address',
            'session.paymentStatus': 'cod',
            'session.paymentAmount': grandTotal
          });
          await sendAddressRequest(userPhone);
        }
        return res.sendStatus(200);
      }
    }

    // Text Message Handler
    if (messageType === 'text') {
      const userText = message.text.body.trim();
      console.log(`${userPhone}: ${userText}`);

      customer = await Customer.findOne({ phone: userPhone });
      const lowerText = userText.toLowerCase();

      if (customer.session.stage === 'new') {
        await sendWelcomeMessage(userPhone);
        return res.sendStatus(200);
      }

      // Continue / New logic
      if (customer.session.askedToContinue) {
        if (lowerText.includes('1') || lowerText.includes('continue')) {
          await updateCustomerSession(userPhone, { 'session.askedToContinue': false });
          await sendTextMessage(userPhone, "Great! Continuing previous conversation 😊");
        } else if (lowerText.includes('2') || lowerText.includes('new')) {
          await resetCustomerSession(userPhone);
          await sendWelcomeMessage(userPhone);
          return res.sendStatus(200);
        }
      }

      if (lowerText === 'send me collection' || lowerText.includes('collection')) {
        await resetCartSession(userPhone);
        await sendSizeButtons(userPhone);
        return res.sendStatus(200);
      }

      if (lowerText.includes('size chart') || lowerText.includes('measurement')) {
        await sendTextMessage(userPhone, "📏 Size Chart:\nS=28-30\nM=30-32\nL=32-34\nXL=34-36 inches");
        return res.sendStatus(200);
      }

      // Product Code
      const detectedCodes = detectProductCodes(userText);
      if (detectedCodes.length > 0 && customer.session.stage === 'browsing') {
        const code = detectedCodes[0];
        const product = products[code];
        if (!product) return res.sendStatus(200);

        const newItem = {
          code, name: product.name, color: product.color,
          size: customer.session.selectedSize || 'M',
          pricePerItem: product.price, quantity: 1, totalPrice: product.price
        };

        const cart = [...(customer.session.cart || []), newItem];

        await updateCustomerSession(userPhone, {
          'session.cart': cart,
          'session.stage': 'quantity',
          'session.pendingCode': code
        });

        await sendTextMessage(userPhone, `✅ Added *${code}*\nHow many do you want?`);
        return res.sendStatus(200);
      }

      // Quantity
      if (customer.session.stage === 'quantity' && customer.session.pendingCode) {
        const qty = parseInt(userText);
        if (!isNaN(qty) && qty > 0) {
          const cart = customer.session.cart.map(item => {
            if (item.code === customer.session.pendingCode) {
              item.quantity = qty;
              item.totalPrice = item.pricePerItem * qty;
            }
            return item;
          });
          await updateCustomerSession(userPhone, { 'session.cart': cart, 'session.pendingCode': null, 'session.stage': 'browsing' });
          await sendTextMessage(userPhone, "✅ Updated!\nReply *Yes* for more or *No* to finish.");
          return res.sendStatus(200);
        }
      }

      // Yes/No more items
      if (customer.session.stage === 'browsing' && customer.session.cart?.length > 0) {
        if (lowerText === 'yes' || lowerText === 'y') {
          await sendTextMessage(userPhone, "Send next product code 😊");
          return res.sendStatus(200);
        }
        if (lowerText === 'no' || lowerText === 'n' || lowerText.includes('done')) {
          await sendPurchaseBill(userPhone, customer);
          return res.sendStatus(200);
        }
      }

      // Address
      if (customer.session.stage === 'address' && userText.length > 40) {
        await updateCustomerSession(userPhone, { 'session.deliveryAddress': userText, 'session.stage': 'confirming' });
        await sendTextMessage(userPhone, "Address saved ✅\nReply *OKAY* or *DONE* to confirm order.");
        return res.sendStatus(200);
      }

      // Final Confirmation
      if (customer.session.stage === 'confirming') {
        if (lowerText.includes('ok') || lowerText.includes('done') || lowerText.includes('yes')) {
          await handleOrderConfirmation(userPhone, customer);
          return res.sendStatus(200);
        }
      }

      // Payment Screenshot via text
      if (customer.session.stage === 'payment' && customer.session.paymentMethod === 'online') {
        if (lowerText.includes('done') || lowerText.includes('paid')) {
          await updateCustomerSession(userPhone, { 'session.stage': 'address', 'session.paymentStatus': 'paid' });
          await sendTextMessage(userPhone, `✅ Payment of ₹${customer.session.grandTotal} confirmed!`);
          await delay(800);
          await sendAddressRequest(userPhone);
          return res.sendStatus(200);
        }
      }

      // AI Sales Assistant
      await handleAIResponse(userPhone, userText, customer);
    }

    // Image (Payment Screenshot)
    if (messageType === 'image') {
      const cust = await Customer.findOne({ phone: userPhone });
      if (cust?.session?.stage === 'payment') {
        await updateCustomerSession(userPhone, { 'session.stage': 'address', 'session.paymentStatus': 'paid' });
        await sendTextMessage(userPhone, "✅ Payment received! Thank you 🙏");
        await delay(800);
        await sendAddressRequest(userPhone);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook Error:', error.message);
    res.sendStatus(200);
  }
});

// ====================== ALL HELPER FUNCTIONS ======================
async function getOrCreateCustomer(phone) {
  try {
    let customer = await Customer.findOne({ phone });
    if (!customer) {
      customer = new Customer({ phone, session: { stage: 'new' } });
      await customer.save();
    } else {
      await Customer.findOneAndUpdate({ phone }, { $inc: { totalVisits: 1 } });
    }
    return customer;
  } catch (e) {
    console.error('Customer Error:', e.message);
    return null;
  }
}

async function updateCustomerSession(phone, data) {
  try {
    await Customer.findOneAndUpdate({ phone }, { $set: data });
  } catch (e) {
    console.error('Update Error:', e.message);
  }
}

async function resetCustomerSession(phone) {
  await updateCustomerSession(phone, {
    session: { stage: 'new', cart: [], selectedSize: null }
  });
}

async function resetCartSession(phone) {
  await updateCustomerSession(phone, {
    'session.cart': [],
    'session.selectedSize': null,
    'session.stage': 'browsing',
    'session.paymentMethod': null
  });
}

async function sendWelcomeMessage(to) {
  await sendTextMessage(to, "Welcome to *Ashirwad Shop*! 👕\nStylish Cotton T-Shirts");
  await delay(600);
  await sendSizeButtons(to);
  await updateCustomerSession(to, { 'session.stage': 'browsing' });
}

async function sendSizeButtons(to) {
  // Your original size button code (2 messages)
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: { type: 'button', body: { text: "Please select your Size:" }, action: { buttons: [
        { type: 'reply', reply: { id: 'size_s', title: 'S' } },
        { type: 'reply', reply: { id: 'size_m', title: 'M' } },
        { type: 'reply', reply: { id: 'size_l', title: 'L' } }
      ]}}
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }});

    await delay(500);
    await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: { type: 'button', body: { text: "More Sizes:" }, action: { buttons: [
        { type: 'reply', reply: { id: 'size_xl', title: 'XL' } },
        { type: 'reply', reply: { id: 'size_xxl', title: 'XXL' } }
      ]}}
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }});
  } catch (e) { console.error('Button Error:', e.message); }
}

async function sendAllProductImages(to, size) {
  await sendTextMessage(to, `Great! Size *${size}* selected.\nHere is our collection 👇`);
  await delay(400);

  for (const code in products) {
    const p = products[code];
    await sendImageMessage(to, p.image_url, `Code: ${code}\nColour: \( {p.color}\nPrice: ₹ \){p.price}`);
    await delay(700);
  }

  await sendTextMessage(to, "Send the *Code* of the T-Shirt you like (e.g. TS01)");
}

function detectProductCodes(text) {
  const upper = text.toUpperCase();
  return Object.keys(products).filter(code => upper.includes(code));
}

// ... (Keep your original calculateTotals, buildBillText, sendPurchaseBill, sendFinalBill, sendAddressRequest, handleOrderConfirmation, sendTextMessage, sendImageMessage, delay, getGroqReply functions)

async function handleAIResponse(phone, userText, customer) {
  // Use your original AI logic here or let me know if you want me to add full AI part too
  await sendTextMessage(phone, "I'm here to help! Please send *Send Me Collection* to start shopping.");
}

// Basic Helpers
async function sendTextMessage(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }}
    );
  } catch (e) { console.error('Send Text Error:', e.message); }
}

async function sendImageMessage(to, imageUrl, caption) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }}
    );
  } catch (e) { console.error('Image Error:', e.message); }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));