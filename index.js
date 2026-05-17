require('dotenv').config();
const express = require('express');
const axios = require('axios');
const products = require('./products');
const { connectDB, Customer } = require('./db');

const app = express();
app.use(express.json());

connectDB();

app.get('/', (req, res) => {
  res.status(200).send('GlassChat server is running!');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─────────────────────────────────────────────────────────────────────
// MAIN WEBHOOK
// ─────────────────────────────────────────────────────────────────────

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

    // Track inbound user interaction timestamp
    await Customer.findOneAndUpdate(
      { phone: userPhone },
      { $set: { lastMessageAt: new Date() } }
    );

    // ── 1. BUTTON TAP HANDLING ──
    if (messageType === 'interactive') {
      const buttonId = message.interactive?.button_reply?.id;
      console.log(`Button Pressed: ${buttonId}`);

      // Size Selection Buttons
      if (['size_s', 'size_m', 'size_l', 'size_xl', 'size_xxl'].includes(buttonId)) {
        const sizeMap = { size_s: 'S', size_m: 'M', size_l: 'L', size_xl: 'XL', size_xxl: 'XXL' };
        const selectedSize = sizeMap[buttonId];
        await updateSession(userPhone, {
          'session.selectedSize': selectedSize,
          'session.stage': 'browsing'
        });
        await sendAllProductImages(userPhone, selectedSize);
        return res.sendStatus(200);
      }

      // Payment Option Buttons
      if (['pay_gpay', 'pay_paytm', 'pay_cod'].includes(buttonId)) {
        customer = await Customer.findOne({ phone: userPhone });

        if (customer.session.paymentMethod) {
          await sendText(userPhone, "⚠️ Payment method already selected.\n\nPlease complete your current payment.");
          return res.sendStatus(200);
        }

        if (customer.session.stage === 'completed') {
          await sendText(userPhone, "✅ Your order is already confirmed.\n\nFor a new order type: *Send Me Collection*");
          return res.sendStatus(200);
        }

        const grandTotal = customer.session.grandTotal || 0;

        if (buttonId === 'pay_gpay' || buttonId === 'pay_paytm') {
          await updateSession(userPhone, {
            'session.paymentMethod': 'online',
            'session.stage': 'payment',
            'session.paymentAmount': grandTotal
          });
          await sendText(userPhone, 
            `✅ *Payment Details:*\n\nGPay / Paytm Number:\n*${process.env.PAYMENT_NUMBER}*\n\nAmount: *₹${grandTotal}*\n\nPlease pay and send screenshot here! 📸`
          );
          return res.sendStatus(200);
        }

        if (buttonId === 'pay_cod') {
          await updateSession(userPhone, {
            'session.paymentMethod': 'cod',
            'session.stage': 'address',
            'session.paymentStatus': 'cod',
            'session.paymentAmount': grandTotal
          });
          await sendAddressRequest(userPhone);
          return res.sendStatus(200);
        }
      }
      return res.sendStatus(200);
    }

    // ── 2. TEXT MESSAGE HANDLING ──
    if (messageType === 'text') {
      const userText = message.text.body.trim();
      const lowerText = userText.toLowerCase();
      console.log(`Text from ${userPhone}: ${userText}`);

      customer = await Customer.findOne({ phone: userPhone });
      const stage = customer.session.stage;

      // Global Direct Commands
      if (stage === 'new') {
        await sendWelcomeMessage(userPhone);
        return res.sendStatus(200);
      }

      if (lowerText === 'send me collection') {
        await resetForNewOrder(userPhone);
        await sendSizeButtons(userPhone);
        return res.sendStatus(200);
      }

      if (lowerText.includes('size in number') || lowerText.includes('size chart') || lowerText.includes('measurement') || lowerText.includes('inch')) {
        await sendText(userPhone, "📏 *Size Chart:*\n\nS  = 28 - 30 inches\n\nM  = 30 - 32 inches\n\nL  = 32 - 34 inches\n\nXL = 34 - 36 inches\n\nXXL = 36 - 38 inches");
        return res.sendStatus(200);
      }

      // Stage-specific Structural Flow Blocks
      if (stage === 'completed') {
        await handleGroqAI(userPhone, userText, customer, 'support');
        return res.sendStatus(200);
      }

      if (stage === 'quantity' && customer.session.pendingCode) {
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

          await updateSession(userPhone, {
            'session.cart': cart,
            'session.pendingCode': null,
            'session.stage': 'browsing'
          });

          await sendText(userPhone, "Okay! 👍\n\nWould you like to select another T-Shirt?\n\nReply *Yes* to select more\n\nReply *No* if you are Done");
          return res.sendStatus(200);
        }
      }

      if (stage === 'browsing') {
        // Step A: Detect code inputs directly to eliminate pipeline drops
        const detectedCodes = detectProductCodes(userText);
        if (detectedCodes.length > 0) {
          const existingCart = customer.session.cart || [];
          for (const code of detectedCodes) {
            const product = products[code];
            if (product) {
              existingCart.push({
                code: code,
                name: product.name,
                color: product.color,
                size: customer.session.selectedSize || 'M',
                pricePerItem: product.price,
                quantity: 1,
                totalPrice: product.price
              });
            }
          }

          const targetCode = detectedCodes[0];
          await updateSession(userPhone, {
            'session.cart': existingCart,
            'session.stage': 'quantity',
            'session.pendingCode': targetCode
          });

          const tgtProduct = products[targetCode];
          await sendText(userPhone, `✅ *Nice Choice!*\n\nCode   : *${targetCode}*\n\nColour : *${tgtProduct.color}*\n\nPrice  : *₹${tgtProduct.price}*\n\nHow many *${targetCode}* do you want?`);
          return res.sendStatus(200);
        }

        // Step B: Multi-item confirmation tracking (Yes/No prompts)
        if (customer.session.cart?.length > 0) {
          if (lowerText === 'yes' || lowerText === 'y') {
            await sendText(userPhone, "Ok I'm waiting! 😊\n\nSend the *Code* of the T-Shirt you want to add!");
            return res.sendStatus(200);
          }
          if (lowerText === 'no' || lowerText === 'n' || lowerText.includes('done') || lowerText.includes('finalize') || lowerText.includes('i want these')) {
            customer = await Customer.findOne({ phone: userPhone });
            await sendPurchaseBill(userPhone, customer);
            return res.sendStatus(200);
          }
        }
      }

      if (stage === 'payment' && customer.session.paymentMethod === 'online') {
        if (['done', 'paid', 'sent', 'payment', 'screenshot'].some(term => lowerText.includes(term))) {
          customer = await Customer.findOne({ phone: userPhone });
          const grandTotal = customer.session.grandTotal || 0;
          await updateSession(userPhone, {
            'session.stage': 'address',
            'session.paymentStatus': 'paid',
            'session.paymentAmount': grandTotal
          });
          await sendText(userPhone, `✅ We received your *₹${grandTotal}* payment!\n\nThank you! 🙏`);
          await delay(500);
          await sendAddressRequest(userPhone);
          return res.sendStatus(200);
        }
      }

      if (stage === 'address') {
        const hasAddressKeywords = ['NAME', 'HOUSE', 'PINCODE', 'CITY', 'STATE'].some(kw => userText.toUpperCase().includes(kw)) || userText.length > 50;
        if (hasAddressKeywords) {
          await updateSession(userPhone, {
            'session.deliveryAddress': userText,
            'session.stage': 'confirming'
          });
          await Customer.findOneAndUpdate({ phone: userPhone }, { $set: { fullAddress: userText } });
          await sendText(userPhone, "Okay ✅");
          await delay(800);
          await sendText(userPhone, "We will dispatch by *Tomorrow!*\n\nYou will receive your parcel within *5-7 Days* 📦\n\nPlease send *OKAY* or *DONE* to confirm your order.");
          
          setTimeout(async () => {
            const fresh = await Customer.findOne({ phone: userPhone });
            if (fresh?.session?.stage === 'confirming') {
              await sendText(userPhone, "⚠️ Please send *OKAY* or *DONE* to confirm your order!");
            }
          }, 2 * 60 * 1000);
          return res.sendStatus(200);
        }
      }

      if (stage === 'confirming') {
        if (['ok', 'done', 'confirm', 'yes', 'thank'].some(term => lowerText.includes(term))) {
          await updateSession(userPhone, {
            'session.stage': 'completed',
            'session.orderConfirmed': true,
            'session.orderConfirmedAt': new Date()
          });

          customer = await Customer.findOne({ phone: userPhone });
          const { orderTotal, discount, discountedTotal, shippingCost, grandTotal } = calculateTotals(customer.session.cart || []);

          const orderData = {
            orderId: 'ORD-' + Date.now(),
            date: new Date(),
            cart: customer.session.cart,
            purchaseBillSent: customer.session.purchaseBillSent,
            orderTotal: orderTotal,
            deliveryCharge: shippingCost,
            grandTotal: grandTotal,
            paymentMethod: customer.session.paymentMethod,
            paymentAmount: grandTotal,
            paymentStatus: customer.session.paymentMethod === 'cod' ? 'cod' : 'paid',
            orderConfirmed: true,
            orderConfirmedAt: new Date(),
            deliveryAddress: customer.session.deliveryAddress,
            parcelShipped: false,
            parcelDelivered: false
          };

          await Customer.findOneAndUpdate(
            { phone: userPhone },
            {
              $push: { orders: orderData },
              $inc: { totalConfirmedOrders: 1 },
              $set: { lastVisit: new Date() }
            }
          );

          await sendText(userPhone, "🎉 *Your Order is Confirmed!*");
          await delay(600);
          customer = await Customer.findOne({ phone: userPhone });
          await sendFinalBill(userPhone, customer);
          await delay(600);
          await sendText(userPhone, "If you have any questions, feel free to ask!\n\n*Thank you for Visiting!* 😄");
          return res.sendStatus(200);
        }
      }

      // If text message does not match structural automation, fallback to AI assistance
      await handleGroqAI(userPhone, userText, customer, 'sales');
    }

    // ── 3. IMAGE MESSAGE HANDLING ──
    if (messageType === 'image') {
      customer = await Customer.findOne({ phone: userPhone });
      if (customer?.session?.stage === 'payment' && customer?.session?.paymentMethod === 'online') {
        const grandTotal = customer.session.grandTotal || 0;
        await updateSession(userPhone, {
          'session.stage': 'address',
          'session.paymentStatus': 'paid',
          'session.paymentAmount': grandTotal
        });
        await sendText(userPhone, `✅ We received your *₹${grandTotal}* payment!\n\nThank you! 🙏`);
        await delay(500);
        await sendAddressRequest(userPhone);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook Runtime Error:', error.message);
    res.sendStatus(200);
  }
});

// ─────────────────────────────────────────────────────────────────────
// GROQ AI HANDLER
// ─────────────────────────────────────────────────────────────────────

async function handleGroqAI(userPhone, userText, customer, mode) {
  const stage = customer.session.stage;
  const customerContext = buildContext(customer);
  let stageInfo = '';

  switch(stage) {
    case 'new':
      stageInfo = 'Customer just arrived. Welcome them.';
      break;
    case 'browsing':
      stageInfo = `Size chosen: ${customer.session.selectedSize}. Product pictures sent. Waiting for product selection code. Cart has ${customer.session.cart?.length || 0} items.`;
      break;
    case 'quantity':
      stageInfo = `Product selected: ${customer.session.pendingCode}. Waiting for quantitative numerical input.`;
      break;
    case 'confirmed':
      stageInfo = 'Bill sent. Options offered. Waiting for user payment choice interaction.';
      break;
    case 'payment':
      stageInfo = `Online checkout waiting state. Value to settle: ₹${customer.session.grandTotal}. Waiting for upload confirmation receipt.`;
      break;
    case 'address':
      stageInfo = 'Payment checked out successfully. Waiting for explicit standard structural shipping data configuration details.';
      break;
    case 'confirming':
      stageInfo = 'Address registered. Dispatched updates finalized. Explicit acknowledgment requested via OKAY/DONE confirmations.';
      break;
    case 'completed':
      stageInfo = 'Order fully confirmed. Static final bill processed. Support operation execution window mode actively listening.';
      break;
  }

  const systemPrompt = `You are Niya, a friendly sales assistant at Ashirwad Shop.
You sell stylish 100% cotton T-Shirts on WhatsApp.

━━━━━━━━━━━━━━
CUSTOMER DATA:
${customerContext}
━━━━━━━━━━━━━━

CURRENT STAGE: ${stage}
WHAT SYSTEM ALREADY DID: ${stageInfo}

━━━━━━━━━━━━━━
YOUR LANGUAGE RULE:
Use very simple talking English by default.
If customer uses any other language — switch to that language immediately and stay in that language.
━━━━━━━━━━━━━━

YOUR PERSONALITY:
- Warm and helpful like a shopkeeper
- Short replies — maximum 3 lines
- Use emojis naturally
- Never reveal you are an AI
- One question at a time
- Always focused on completing the sale

━━━━━━━━━━━━━━
SHOP INFORMATION:
━━━━━━━━━━━━━━
PRODUCTS: ${JSON.stringify(products)}
FABRIC: 100% Cotton

SIZE CHART:
S=28-30in, M=30-32in, L=32-34in, XL=34-36in, XXL=36-38in

OFFERS:
- Buy 2 T-Shirts = 10% discount
- Buy 3 or more = 20% discount

SHIPPING:
- Below ₹999 = ₹99 charge
- Above ₹999 = FREE

PAYMENT: GPay / Paytm / Cash on Delivery

RETURN POLICY:
- Return only if product is damaged
- Unboxing video is compulsory for return
- No exchange available

━━━━━━━━━━━━━━
PRODUCT CODE RULES:
━━━━━━━━━━━━━━
NEVER add product to cart yourself. Only use ADD_TO_CART tag after customer confirms.
If customer states explicitly "I like TS01" or "TS01 looks nice": Ask: "Want to add TS01 to your order?" and wait for explicit confirmation.

━━━━━━━━━━━━━━
TAGS — ADD AT END OF REPLY ONLY:
ADD_TO_CART:TS01 | REMOVE_ITEM:TS01 | UPDATE_QTY:TS01:3
━━━━━━━━━━━━━━
STRICT COMPLIANCE: Short lines, no manufactured variables, check states continuously.`;

  const recentHistory = customer.session.conversationHistory || [];
  recentHistory.push({ role: 'user', content: userText });

  const aiReply = await getGroqReply(recentHistory, systemPrompt);

  // Parse structural additions via regex matching configurations
  const addMatch = aiReply.match(/ADD_TO_CART:([\w,]+)/i);
  if (addMatch && stage === 'browsing') {
    const codes = addMatch[1].split(',');
    const existingCart = customer.session.cart || [];

    for (const code of codes) {
      const trimmedCode = code.trim().toUpperCase();
      const product = products[trimmedCode];
      if (product) {
        existingCart.push({
          code: trimmedCode,
          name: product.name,
          color: product.color,
          size: customer.session.selectedSize || 'M',
          pricePerItem: product.price,
          quantity: 1,
          totalPrice: product.price
        });
      }
    }

    const targetedFirst = codes[0].trim().toUpperCase();
    await updateSession(userPhone, {
      'session.cart': existingCart,
      'session.stage': 'quantity',
      'session.pendingCode': targetedFirst
    });

    const cleanReply = aiReply.replace(/ADD_TO_CART:[\w,]+/gi, '').trim();
    if (cleanReply.length > 0) {
      await sendText(userPhone, cleanReply);
      await delay(500);
    }

    const productRef = products[targetedFirst];
    await sendText(userPhone, `✅ *Nice Choice!*\n\nCode   : *${targetedFirst}*\n\nColour : *${productRef.color}*\n\nPrice  : *₹${productRef.price}*\n\nHow many *${targetedFirst}* do you want?`);
    return;
  }

  // Parse item destruction or removal adjustments
  const removeMatch = aiReply.match(/REMOVE_ITEM:(\w+)/i);
  if (removeMatch) {
    const removeCode = removeMatch[1].toUpperCase();
    const updatedCart = (customer.session.cart || []).filter(item => item.code !== removeCode);
    await updateSession(userPhone, { 'session.cart': updatedCart });
  }

  // Parse mutation requests on existing arrays
  const updateQtyMatch = aiReply.match(/UPDATE_QTY:(\w+):(\d+)/i);
  if (updateQtyMatch) {
    const updateCode = updateQtyMatch[1].toUpperCase();
    const newQty = parseInt(updateQtyMatch[2]);
    const updatedCart = (customer.session.cart || []).map(item => {
      if (item.code === updateCode) {
        item.quantity = newQty;
        item.totalPrice = item.pricePerItem * newQty;
      }
      return item;
    });
    await updateSession(userPhone, { 'session.cart': updatedCart });
  }

  const cleanReply = aiReply
    .replace(/ADD_TO_CART:[\w,]+/gi, '')
    .replace(/REMOVE_ITEM:\w+/gi, '')
    .replace(/UPDATE_QTY:\w+:\d+/gi, '')
    .trim();

  recentHistory.push({ role: 'assistant', content: cleanReply });
  await updateSession(userPhone, { 'session.conversationHistory': recentHistory.slice(-40) });

  if (cleanReply.length > 0) {
    await sendText(userPhone, cleanReply);
  }
}

// ─────────────────────────────────────────────────────────────────────
// SERVICE PLATFORM PIPELINES (FLOW)
// ─────────────────────────────────────────────────────────────────────

async function sendWelcomeMessage(to) {
  await sendText(to, "Welcome to *Ashirwad Shop*! 👕\n\nBuy Stylish T-Shirts from us!");
  await delay(500);
  await sendSizeButtons(to);
  await updateSession(to, { 'session.stage': 'browsing' });
}

async function sendSizeButtons(to) {
  try {
    const endpoint = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`;
    const configHeaders = { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } };

    await axios.post(endpoint, {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button', body: { text: "Please select your Size: 👇" },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'size_s', title: 'S' } },
            { type: 'reply', reply: { id: 'size_m', title: 'M' } },
            { type: 'reply', reply: { id: 'size_l', title: 'L' } }
          ]
        }
      }
    }, configHeaders);

    await delay(500);

    await axios.post(endpoint, {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button', body: { text: "More sizes:" },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'size_xl', title: 'XL' } },
            { type: 'reply', reply: { id: 'size_xxl', title: 'XXL' } }
          ]
        }
      }
    }, configHeaders);
  } catch (error) {
    console.error('Size rendering operation error:', error.message);
  }
}

async function sendAllProductImages(to, size) {
  await sendText(to, `Great! You selected Size *${size}* 👍\n\nHere is our T-Shirt Collection 👇`);
  await delay(300);

  for (const code in products) {
    const product = products[code];
    const caption = `Code: ${code}\nColour: ${product.color}\nPrice: ₹${product.price}`;
    await sendImage(to, product.image_url, caption);
    await delay(600);
  }
  await delay(500);
  await sendText(to, "⬆️ Send the *Code* of the T-Shirt you want to buy!\n\nExample: *TS01*\n\nOr send multiple: *TS01 TS03*");
}

function calculateTotals(cart) {
  let orderTotal = 0;
  cart.forEach(item => { orderTotal += (item.totalPrice || item.pricePerItem); });
  
  let discount = 0;
  if (cart.length === 2) discount = orderTotal * 0.10;
  if (cart.length >= 3) discount = orderTotal * 0.20;
  
  const discountedTotal = orderTotal - discount;
  const shippingCost = discountedTotal >= 999 ? 0 : 99;
  const grandTotal = discountedTotal + shippingCost;
  
  return { orderTotal, discount, discountedTotal, shippingCost, grandTotal };
}

function buildBillText(cart, orderTotal, discountedTotal, discount, shippingCost, grandTotal, billType, confirmDateTime) {
  const title = billType === 'final' ? "🧾 *Final Bill:*" : "🧾 *Purchase Bill:*";
  let bill = `${title}\n─────────────────\n\n`;

  cart.forEach((item, index) => {
    bill += `*T-Shirt ${index + 1}:*\nCode     : ${item.code}\nSize     : ${item.size}\nColour   : ${item.color}\nQuantity : ${item.quantity}\nPrice    : ₹${item.totalPrice || item.pricePerItem}\n\n`;
  });

  bill += `─────────────────\n`;
  if (discount > 0) {
    bill += `Original  : ₹${orderTotal}\nDiscount  : -₹${discount.toFixed(0)}\n`;
  }
  bill += `Total     : ₹${discountedTotal.toFixed(0)}\nShipping  : ${shippingCost === 0 ? 'FREE 🎉' : '₹' + shippingCost}\n─────────────────\n*Grand Total : ₹${grandTotal.toFixed(0)}*\n─────────────────`;

  if (billType === 'final' && confirmDateTime) {
    bill += `\n\n─────────────────\nConfirmed :\n${confirmDateTime}\n─────────────────`;
  }
  return bill;
}

async function sendPurchaseBill(phone, customer) {
  const cart = customer.session.cart || [];
  if (cart.length === 0) {
    await sendText(phone, "No items selected yet.\n\nPlease select a T-Shirt first!");
    return;
  }

  const { orderTotal, discount, discountedTotal, shippingCost, grandTotal } = calculateTotals(cart);

  await updateSession(phone, {
    'session.orderTotal': discountedTotal,
    'session.deliveryCharge': shippingCost,
    'session.grandTotal': grandTotal,
    'session.stage': 'confirmed',
    'session.purchaseBillSent': true
  });

  const bill = buildBillText(cart, orderTotal, discountedTotal, discount, shippingCost, grandTotal, 'purchase', null);
  await sendText(phone, bill);
  await delay(800);

  try {
    await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', to: phone, type: 'interactive',
      interactive: {
        type: 'button', body: { text: "How will you make Payment? 💳" },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'pay_gpay', title: '💳 GPay/Paytm' } },
            { type: 'reply', reply: { id: 'pay_cod', title: '💵 Cash on Delivery' } }
          ]
        }
      }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('Payment configuration interactive load fault:', error.message);
  }
}

async function sendFinalBill(phone, customer) {
  const cart = customer.session.cart || [];
  if (cart.length === 0) return;

  const { orderTotal, discount, discountedTotal, shippingCost, grandTotal } = calculateTotals(cart);
  const confirmDateTime = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
  });

  const bill = buildBillText(cart, orderTotal, discountedTotal, discount, shippingCost, grandTotal, 'final', confirmDateTime);
  await sendText(phone, bill);
}

async function sendAddressRequest(phone) {
  await sendText(phone, "📦 Please send your *Shipping Address*\n*(in English only)*:\n\nNAME -\n\nHOUSE NO -\n\nADDRESS -\n\nLANDMARK -\n\nCITY -\n\nPINCODE -\n\nDISTRICT -\n\nSTATE -\n\nPHONE NO -");
}

async function resetForNewOrder(phone) {
  await updateSession(phone, {
    'session.stage': 'browsing', 'session.cart': [], 'session.selectedSize': null, 'session.pendingCode': null,
    'session.purchaseBillSent': false, 'session.orderTotal': 0, 'session.deliveryCharge': 99, 'session.grandTotal': 0,
    'session.paymentMethod': null, 'session.paymentAmount': 0, 'session.paymentStatus': 'pending', 'session.orderConfirmed': false,
    'session.orderConfirmedAt': null, 'session.parcelShipped': false, 'session.parcelDelivered': false, 'session.deliveryAddress': null,
    'session.conversationHistory': []
  });
}

// ─────────────────────────────────────────────────────────────────────
// UTILITIES AND CORE API METHODS
// ─────────────────────────────────────────────────────────────────────

async function getOrCreateCustomer(phone) {
  try {
    let customer = await Customer.findOne({ phone });
    if (!customer) {
      customer = new Customer({ phone, session: { stage: 'new' }, lastMessageAt: new Date() });
      await customer.save();
      console.log(`New Customer Registration Instance created: ${phone}`);
    } else {
      await Customer.findOneAndUpdate({ phone }, { $inc: { totalVisits: 1 } });
    }
    return customer;
  } catch (error) {
    console.error('Database transaction error on customer verification:', error.message);
    return null;
  }
}

function buildContext(customer) {
  let context = customer.totalVisits > 1 ? `RETURNING CUSTOMER\n` : `NEW CUSTOMER\n`;
  context += `Total Visits: ${customer.totalVisits}\nTotal Orders: ${customer.totalConfirmedOrders}\nPhone: ${customer.phone}\nSTAGE: ${customer.session.stage}\n`;
  if (customer.session.selectedSize) context += `Selected Size: ${customer.session.selectedSize}\n`;
  
  if (customer.session.cart?.length > 0) {
    context += `\nCURRENT ACCOUNT CART:\n`;
    customer.session.cart.forEach(i => { context += `- ${i.code} | Qty:${i.quantity} | Total: ₹${i.totalPrice}\n`; });
    context += `Grand Total Amount Calculated: ₹${customer.session.grandTotal}\n`;
  }
  return context;
}

async function updateSession(phone, data) {
  try {
    await Customer.findOneAndUpdate({ phone }, { $set: data }, { new: true });
  } catch (error) {
    console.error('Session persistence failed update:', error.message);
  }
}

function detectProductCodes(text) {
  const upperText = text.toUpperCase();
  const foundCodes = [];
  for (const code in products) {
    // Regex matches the product code as an isolated whole word boundary
    const regex = new RegExp(`\\b${code}\\b`, 'g');
    if (regex.test(upperText)) {
      foundCodes.push(code);
    }
  }
  return foundCodes;
}

async function sendText(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, 
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Send textual string dispatch error details:', error.message);
  }
}

async function sendImage(to, imageUrl, caption) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption: caption } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Media dispatch processing error output:', error.message);
  }
}

async function getGroqReply(history, systemPrompt) {
  try {
    const messages = [{ role: 'system', content: systemPrompt }];

    history.forEach(msg => {
      // Map properties consistently to standard chat structure format
      const role = msg.role === 'model' || msg.role === 'assistant' ? 'assistant' : 'user';
      const content = msg.content || (msg.parts && msg.parts[0]?.text);
      if (content && content.trim() !== '') {
        messages.push({ role, content });
      }
    });

    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', messages, max_tokens: 500, temperature: 0.4 },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('Groq LLM processing fault exceptions:', error.message);
    return "Sorry, please try again in a moment!";
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GlassChat server running on port ${PORT}`);
});
