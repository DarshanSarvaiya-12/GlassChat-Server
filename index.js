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

// ====================== MAIN WHATSAPP WEBHOOK ======================
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const userPhone = message.from;
    const messageType = message.type;

    // Get or create customer
    let customer = await getOrCreateCustomer(userPhone);
    if (!customer) return res.sendStatus(200);

    // Update last message time
    await Customer.findOneAndUpdate({ phone: userPhone }, { lastMessageAt: new Date() });

    // ── INTERACTIVE BUTTON HANDLER ──
    if (messageType === 'interactive') {
      const buttonId = message.interactive?.button_reply?.id;
      console.log(`Button pressed: ${buttonId}`);

      // Size Selection
      if (['size_s', 'size_m', 'size_l', 'size_xl', 'size_xxl'].includes(buttonId)) {
        const sizeMap = { size_s: 'S', size_m: 'M', size_l: 'L', size_xl: 'XL', size_xxl: 'XXL' };
        const selectedSize = sizeMap[buttonId];

        await updateCustomerSession(userPhone, {
          'session.selectedSize': selectedSize,
          'session.stage': 'browsing',
          'session.cart': []
        });

        await sendAllProductImages(userPhone, selectedSize);
        return res.sendStatus(200);
      }

      // Payment Method Selection
      if (['pay_gpay', 'pay_paytm', 'pay_cod'].includes(buttonId)) {
        customer = await Customer.findOne({ phone: userPhone });

        if (customer.session.paymentMethod) {
          await sendTextMessage(userPhone, "⚠️ Payment method already selected.\n\nPlease complete current order first.");
          return res.sendStatus(200);
        }

        const grandTotal = customer.session.grandTotal || 0;

        if (buttonId === 'pay_gpay' || buttonId === 'pay_paytm') {
          await updateCustomerSession(userPhone, {
            'session.paymentMethod': 'online',
            'session.stage': 'payment',
            'session.paymentAmount': grandTotal
          });

          await sendTextMessage(userPhone,
            `✅ *Payment Details:*\n\n` +
            `GPay / Paytm: *${process.env.PAYMENT_NUMBER || '9999999999'}*\n\n` +
            `Amount: *₹${grandTotal}*\n\n` +
            `Send exact amount and screenshot here after payment 📸`
          );
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

    // ── TEXT MESSAGE HANDLER ──
    if (messageType === 'text') {
      const userText = message.text.body.trim();
      console.log(`${userPhone}: ${userText}`);

      customer = await Customer.findOne({ phone: userPhone });
      const lowerText = userText.toLowerCase();

      // New Customer
      if (customer.session.stage === 'new') {
        await sendWelcomeMessage(userPhone);
        return res.sendStatus(200);
      }

      // Handle Continue / New Conversation
      if (customer.session.askedToContinue) {
        if (lowerText.includes('1') || lowerText.includes('continue')) {
          await updateCustomerSession(userPhone, { 'session.askedToContinue': false });
          await sendTextMessage(userPhone, "Great! Continuing from where we left off 😊");
        } else if (lowerText.includes('2') || lowerText.includes('new')) {
          await resetCustomerSession(userPhone);
          await sendWelcomeMessage(userPhone);
          return res.sendStatus(200);
        }
      }

      // Collection Request
      if (lowerText === 'send me collection' || lowerText.includes('collection')) {
        await resetCartSession(userPhone);
        await sendSizeButtons(userPhone);
        return res.sendStatus(200);
      }

      // Size Chart Request
      if (lowerText.includes('size chart') || lowerText.includes('size number') || lowerText.includes('measurement')) {
        await sendTextMessage(userPhone,
          "📏 *Size Chart:*\n\n" +
          "S  = 28 - 30 inches\n" +
          "M  = 30 - 32 inches\n" +
          "L  = 32 - 34 inches\n" +
          "XL = 34 - 36 inches\n\n" +
          `Your selected size: ${customer.session.selectedSize || 'Not selected'}`
        );
        return res.sendStatus(200);
      }

      // Product Code Detection
      const detectedCodes = detectProductCodes(userText);
      if (detectedCodes.length > 0 && customer.session.stage === 'browsing') {
        const code = detectedCodes[0];
        const product = products[code];

        if (!product) {
          await sendTextMessage(userPhone, "Sorry, this code is not available.");
          return res.sendStatus(200);
        }

        const newItem = {
          code,
          name: product.name,
          color: product.color,
          size: customer.session.selectedSize || 'M',
          pricePerItem: product.price,
          quantity: 1,
          totalPrice: product.price
        };

        const cart = [...(customer.session.cart || []), newItem];

        await updateCustomerSession(userPhone, {
          'session.cart': cart,
          'session.stage': 'quantity',
          'session.pendingCode': code
        });

        await sendTextMessage(userPhone,
          `✅ *Added to Cart!*\n\n` +
          `Code   : *${code}*\n` +
          `Colour : *${product.color}*\n` +
          `Price  : *₹${product.price}*\n\n` +
          `*How many ${code}* would you like?`
        );
        return res.sendStatus(200);
      }

      // Quantity Input
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

          await updateCustomerSession(userPhone, {
            'session.cart': cart,
            'session.pendingCode': null,
            'session.stage': 'browsing'
          });

          await sendTextMessage(userPhone,
            "✅ Quantity updated!\n\n" +
            "Would you like to add more?\n" +
            "Reply *Yes* or send another code\n" +
            "Reply *No* when you are done"
          );
          return res.sendStatus(200);
        }
      }

      // Yes / No for more items
      if (customer.session.stage === 'browsing' && customer.session.cart?.length > 0) {
        if (lowerText === 'yes' || lowerText === 'y') {
          await sendTextMessage(userPhone, "Please send the *Code* of next T-Shirt 😊");
          return res.sendStatus(200);
        }

        if (lowerText === 'no' || lowerText === 'n' || lowerText.includes('done') || lowerText.includes('finalize')) {
          await sendPurchaseBill(userPhone, customer);
          return res.sendStatus(200);
        }
      }

      // Address Submission
      if (customer.session.stage === 'address' && userText.length > 30) {
        await updateCustomerSession(userPhone, {
          'session.deliveryAddress': userText,
          'session.stage': 'confirming'
        });

        await Customer.findOneAndUpdate({ phone: userPhone }, { $set: { fullAddress: userText } });

        await sendTextMessage(userPhone, "Address saved ✅\n\nWe dispatch tomorrow. Delivery in 5-7 days.");
        await delay(1000);
        await sendTextMessage(userPhone, "Please reply *OKAY* or *DONE* to confirm your order.");
        return res.sendStatus(200);
      }

      // Order Confirmation
      if (customer.session.stage === 'confirming') {
        if (lowerText.includes('ok') || lowerText.includes('done') || lowerText.includes('confirm') || lowerText.includes('yes')) {
          await handleOrderConfirmation(userPhone, customer);
          return res.sendStatus(200);
        }
      }

      // Online Payment Confirmation
      if (customer.session.stage === 'payment' && customer.session.paymentMethod === 'online') {
        if (lowerText.includes('done') || lowerText.includes('paid') || lowerText.includes('screenshot')) {
          await updateCustomerSession(userPhone, {
            'session.stage': 'address',
            'session.paymentStatus': 'paid'
          });
          await sendTextMessage(userPhone, `✅ Payment of ₹${customer.session.grandTotal} received! Thank you 🙏`);
          await delay(800);
          await sendAddressRequest(userPhone);
          return res.sendStatus(200);
        }
      }

      // ── AI SALES ASSISTANT (Fallback for everything else) ──
      await handleAIResponse(userPhone, userText, customer);
    }

    // ── IMAGE HANDLER (Payment Screenshot) ──
    if (messageType === 'image') {
      const cust = await Customer.findOne({ phone: userPhone });
      if (cust?.session?.stage === 'payment' && cust.session.paymentMethod === 'online') {
        await updateCustomerSession(userPhone, { 'session.stage': 'address', 'session.paymentStatus': 'paid' });
        await sendTextMessage(userPhone, `✅ Payment received! Thank you 🙏`);
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

// ====================== ORDER CONFIRMATION ======================
async function handleOrderConfirmation(phone, customer) {
  await updateCustomerSession(phone, {
    'session.stage': 'completed',
    'session.orderConfirmed': true,
    'session.orderConfirmedAt': new Date()
  });

  const freshCustomer = await Customer.findOne({ phone });

  const orderData = {
    orderId: 'ORD-' + Date.now(),
    date: new Date(),
    cart: freshCustomer.session.cart,
    orderTotal: freshCustomer.session.orderTotal,
    deliveryCharge: freshCustomer.session.deliveryCharge,
    grandTotal: freshCustomer.session.grandTotal,
    paymentMethod: freshCustomer.session.paymentMethod,
    paymentStatus: freshCustomer.session.paymentMethod === 'cod' ? 'cod' : 'paid',
    deliveryAddress: freshCustomer.session.deliveryAddress,
    orderConfirmed: true,
    orderConfirmedAt: new Date()
  };

  await Customer.findOneAndUpdate(
    { phone },
    { $push: { orders: orderData }, $inc: { totalConfirmedOrders: 1 }, $set: { lastVisit: new Date() } }
  );

  await sendTextMessage(phone, "🎉 *Order Confirmed Successfully!*");
  await delay(800);
  await sendFinalBill(phone, freshCustomer);
  await delay(800);
  await sendTextMessage(phone, "Thank you for shopping with Ashirwad Shop! 😊\nFeel free to ask if you need any help.");
}

// ====================== AI SALES ASSISTANT ======================
async function handleAIResponse(phone, userText, customer) {
  const customerContext = buildCustomerContext(customer);

  const systemPrompt = `You are Niya, a warm and professional sales assistant at Ashirwad Shop - premium cotton T-shirts.

CUSTOMER INFO:
${customerContext}

PERSONALITY & RULES:
- Be friendly, helpful and sales-focused
- Use simple English
- Keep replies short (max 3-4 lines)
- Use emojis naturally
- Ask only ONE question at a time
- Always guide towards completing the purchase
- Never reveal you are AI

SHOP INFO:
- 100% Cotton T-Shirts
- Sizes: S(28-30), M(30-32), L(32-34), XL(34-36)
- Buy 2 = 10% off | Buy 3+ = 20% off
- Shipping: Free above ₹999, else ₹99
- Payment: GPay/Paytm / Cash on Delivery

STRICT RULES:
- Never make up product codes or prices
- Never promise free items or exchange (only damaged return with video)
- After order confirmed → support mode only (no new orders)
- Use tags only at the end: REMOVE_ITEM:CODE or UPDATE_QTY:CODE:QUANTITY`;

  // ... (rest of Groq call same as your original with minor improvements)
  // I kept your Groq logic but you can keep your existing getGroqReply function
  const aiReply = await getGroqReply(customer.session.conversationHistory || [], systemPrompt, userText);

  // Parse special tags
  const removeMatch = aiReply.match(/REMOVE_ITEM:(\w+)/i);
  if (removeMatch) {
    const code = removeMatch[1];
    const newCart = customer.session.cart.filter(i => i.code !== code);
    await updateCustomerSession(phone, { 'session.cart': newCart });
  }

  const qtyMatch = aiReply.match(/UPDATE_QTY:(\w+):(\d+)/i);
  if (qtyMatch) {
    const [_, code, qty] = qtyMatch;
    const newCart = customer.session.cart.map(item => {
      if (item.code === code) {
        item.quantity = parseInt(qty);
        item.totalPrice = item.pricePerItem * parseInt(qty);
      }
      return item;
    });
    await updateCustomerSession(phone, { 'session.cart': newCart });
  }

  const cleanReply = aiReply
    .replace(/REMOVE_ITEM:\w+/gi, '')
    .replace(/UPDATE_QTY:\w+:\d+/gi, '')
    .trim();

  // Save history
  const history = customer.session.conversationHistory || [];
  history.push({ role: 'user', parts: [{ text: userText }] });
  history.push({ role: 'model', parts: [{ text: cleanReply }] });

  await updateCustomerSession(phone, {
    'session.conversationHistory': history.slice(-50)
  });

  if (cleanReply) await sendTextMessage(phone, cleanReply);
}

// ====================== YOUR EXISTING HELPER FUNCTIONS ======================
// (sendWelcomeMessage, sendSizeButtons, sendAllProductImages, buildBillText, calculateTotals,
// sendPurchaseBill, sendFinalBill, sendAddressRequest, getOrCreateCustomer, updateCustomerSession,
// detectProductCodes, sendTextMessage, sendImageMessage, delay, etc.)

// Please copy all your helper functions from the original file (they are already good).
// I have kept the structure same so you can merge easily.

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ GlassChat server running on port ${PORT}`);
});