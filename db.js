const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected!');
  } catch (error) {
    console.error('MongoDB error:', error.message);
  }
};

// 7 day expiry session schema
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
  contactNumber: {
    type: String,
    default: null
  },
  
  // CURRENT SESSION - 7 day realtime data
  session: {
    stage: {
      type: String,
      enum: [
        'new',
        'browsing',
        'confirmed',
        'sizing',
        'quantity',
        'address',
        'payment',
        'completed'
      ],
      default: 'new'
    },
    cart: [{
      code: String,
      name: String,
      color: String,
      size: String,
      quantity: { type: Number, default: 1 },
      pricePerItem: Number,
      totalPrice: Number
    }],
    deliveryAddress: {
      type: String,
      default: null
    },
    orderTotal: {
      type: Number,
      default: 0
    },
    deliveryCharge: {
      type: Number,
      default: 99
    },
    grandTotal: {
      type: Number,
      default: 0
    },
    conversationHistory: {
  type: Array,
  default: []
},
    // AUTO EXPIRE after 7 days
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
    orderId: String,
    date: {
      type: Date,
      default: Date.now
    },
    cart: [{
      code: String,
      name: String,
      color: String,
      size: String,
      quantity: Number,
      pricePerItem: Number,
      totalPrice: Number
    }],
    deliveryAddress: String,
    grandTotal: Number,
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid'],
      default: 'pending'
    },
    deliveryStatus: {
      type: String,
      enum: [
        'pending',
        'processing',
        'shipped',
        'delivered'
      ],
      default: 'pending'
    }
  }],
  
  // VISIT TRACKING
  firstVisit: {
    type: Date,
    default: Date.now
  },
  lastVisit: {
    type: Date,
    default: Date.now
  },
  totalVisits: {
    type: Number,
    default: 1
  },
  
  // PREFERENCES
  preferences: {
    sizes: { type: Object, default: {} },
    colors: { type: [String], default: [] }
  }
  
});

const Customer = mongoose.model(
  'Customer',
  customerSchema
);

module.exports = { connectDB, Customer };