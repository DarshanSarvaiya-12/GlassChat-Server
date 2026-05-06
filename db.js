const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected!');
  } catch (error) {
    console.error('MongoDB error:', error.message);
  }
};

const customerSchema = new mongoose.Schema({

  // IDENTITY
  phone: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    default: null
  },
  language: {
    type: String,
    default: 'English'
  },
  fullAddress: {
    type: String,
    default: null
  },

  // VISIT TRACKING
  firstVisit: {
    type: Date,
    default: Date.now
  },
  lastVisit: {
    type: Date,
    default: Date.now
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  totalVisits: {
    type: Number,
    default: 1
  },
  totalConfirmedOrders: {
    type: Number,
    default: 0
  },

  // CURRENT SESSION
  session: {

    stage: {
      type: String,
      enum: [
        'new',
        'browsing',
        'quantity',
        'confirmed',
        'payment',
        'address',
        'confirming',
        'completed'
      ],
      default: 'new'
    },

    cart: [{
      code: String,
      name: String,
      color: String,
      size: { type: String, default: null },
      quantity: { type: Number, default: 1 },
      pricePerItem: Number,
      totalPrice: { type: Number, default: 0 }
    }],

    selectedSize: { type: String, default: null },
    pendingCode: { type: String, default: null },

    purchaseBillSent: { type: Boolean, default: false },
    orderTotal: { type: Number, default: 0 },
    deliveryCharge: { type: Number, default: 99 },
    grandTotal: { type: Number, default: 0 },

    paymentMethod: { type: String, default: null },
    paymentAmount: { type: Number, default: 0 },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'cod'],
      default: 'pending'
    },

    orderConfirmed: { type: Boolean, default: false },
    orderConfirmedAt: { type: Date, default: null },

    parcelShipped: { type: Boolean, default: false },
    parcelShippedAt: { type: Date, default: null },
    parcelDelivered: { type: Boolean, default: false },
    parcelDeliveredAt: { type: Date, default: null },

    deliveryAddress: { type: String, default: null },

    pendingConfirmation: { type: Boolean, default: false },

    conversationHistory: {
      type: Array,
      default: []
    },

    expiresAt: {
      type: Date,
      default: () => new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      ),
      index: { expires: 0 }
    }
  },

  // ORDER HISTORY
  orders: [{
    orderId: {
      type: String,
      default: () => 'ORD-' + Date.now()
    },
    date: { type: Date, default: Date.now },
    cart: [{
      code: String,
      name: String,
      color: String,
      size: String,
      quantity: Number,
      pricePerItem: Number,
      totalPrice: Number
    }],
    purchaseBillSent: { type: Boolean, default: false },
    orderTotal: Number,
    deliveryCharge: Number,
    grandTotal: Number,
    paymentMethod: String,
    paymentAmount: { type: Number, default: 0 },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'cod'],
      default: 'pending'
    },
    orderConfirmed: { type: Boolean, default: false },
    orderConfirmedAt: { type: Date, default: null },
    deliveryAddress: String,
    parcelShipped: { type: Boolean, default: false },
    parcelShippedAt: { type: Date, default: null },
    parcelDelivered: { type: Boolean, default: false },
    parcelDeliveredAt: { type: Date, default: null }
  }]

});

const Customer = mongoose.model('Customer', customerSchema);

module.exports = { connectDB, Customer };