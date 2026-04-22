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
  
  session: {
    stage: {
      type: String,
      enum: [
        'new',
        'welcomed',
        'size_selected',
        'browsing',
        'item_selecting',
        'awaiting_more',
        'payment_method',
        'awaiting_payment',
        'cod_address',
        'online_address',
        'awaiting_confirmation',
        'completed'
      ],
      default: 'new'
    },
    
    selectedSize: {
      type: String,
      default: null
    },
    
    cart: [{
      code: String,
      name: String,
      color: String,
      size: String,
      quantity: {
        type: Number,
        default: 1
      },
      pricePerItem: Number,
      totalPrice: Number
    }],
    
    currentItem: {
      type: Object,
      default: null
    },
    
    paymentMethod: {
      type: String,
      default: null
    },
    
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

    // New Fields added here
    pendingCode: {
      type: String,
      default: null
    },
    askedToContinue: {
      type: Boolean,
      default: false
    },
    pendingConfirmation: {
      type: Boolean,
      default: false
    },
    
    expiresAt: {
      type: Date,
      default: () => new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      ),
      index: { expires: 0 }
    }
  },
  
  orders: [{
    orderId: {
      type: String,
      default: () => 'ORD-' + Date.now()
    },
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
    orderTotal: Number,
    deliveryCharge: Number,
    grandTotal: Number,
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'cod'],
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

  // Main Schema addition
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  
  preferences: {
    sizes: {
      type: Object,
      default: {}
    },
    colors: {
      type: [String],
      default: []
    }
  }
});

const Customer = mongoose.model('Customer', customerSchema);

// ... Settings Schema and Export logic remains the same
