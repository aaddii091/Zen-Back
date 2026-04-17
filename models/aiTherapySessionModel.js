const mongoose = require('mongoose');

const therapyKeyMomentSchema = new mongoose.Schema(
  {
    phase: {
      type: String,
      enum: ['check_in', 'goal', 'trigger_map', 'reframe', 'action_plan', 'safety', 'close'],
      required: true,
    },
    label: {
      type: String,
      trim: true,
      required: true,
      maxlength: 120,
    },
    note: {
      type: String,
      trim: true,
      required: true,
      maxlength: 2000,
    },
    capturedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true },
);

const aiTherapySessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'completed', 'aborted', 'safety_paused', 'failed'],
      default: 'active',
      index: true,
    },
    startedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    endedAt: Date,
    durationSec: {
      type: Number,
      min: 0,
      default: 0,
    },
    engine: {
      provider: {
        type: String,
        default: 'openai',
      },
      model: {
        type: String,
        trim: true,
        default: '',
      },
      voice: {
        type: String,
        trim: true,
        default: '',
      },
      flowVersion: {
        type: String,
        trim: true,
        default: 'therapy-flow-v1',
      },
    },
    phaseState: {
      checkIn: {
        moodScore: {
          type: Number,
          min: 0,
          max: 10,
          default: null,
        },
        currentEmotions: {
          type: [String],
          default: [],
        },
        context: {
          type: String,
          trim: true,
          default: '',
        },
      },
      sessionGoal: {
        goal: {
          type: String,
          trim: true,
          default: '',
        },
      },
      triggerMap: {
        situation: {
          type: String,
          trim: true,
          default: '',
        },
        automaticThought: {
          type: String,
          trim: true,
          default: '',
        },
        bodySignal: {
          type: String,
          trim: true,
          default: '',
        },
        behaviorLoop: {
          type: String,
          trim: true,
          default: '',
        },
      },
      reframe: {
        balancedThought: {
          type: String,
          trim: true,
          default: '',
        },
        evidenceFor: {
          type: String,
          trim: true,
          default: '',
        },
        evidenceAgainst: {
          type: String,
          trim: true,
          default: '',
        },
      },
      actionPlan: {
        step24h: {
          type: String,
          trim: true,
          default: '',
        },
        step7d: {
          type: String,
          trim: true,
          default: '',
        },
        frictionBlocker: {
          type: String,
          trim: true,
          default: '',
        },
        copingStrategy: {
          type: String,
          trim: true,
          default: '',
        },
      },
      completion: {
        summarySignal: {
          type: String,
          trim: true,
          default: '',
        },
        confidenceScore: {
          type: Number,
          min: 0,
          max: 10,
          default: null,
        },
      },
    },
    safety: {
      riskLevel: {
        type: String,
        enum: ['none', 'low', 'high', 'imminent'],
        default: 'none',
      },
      escalated: {
        type: Boolean,
        default: false,
      },
      reason: {
        type: String,
        trim: true,
        default: '',
      },
      resourcesShown: {
        type: [String],
        default: [],
      },
    },
    keyMoments: {
      type: [therapyKeyMomentSchema],
      default: [],
    },
    report: {
      sessionSnapshot: {
        type: String,
        trim: true,
        default: '',
      },
      whatYouShared: {
        type: String,
        trim: true,
        default: '',
      },
      patternsNoticed: {
        type: String,
        trim: true,
        default: '',
      },
      helpfulReframes: {
        type: String,
        trim: true,
        default: '',
      },
      actionPlan24h: {
        type: String,
        trim: true,
        default: '',
      },
      actionPlan7d: {
        type: String,
        trim: true,
        default: '',
      },
      copingPlanWhenTriggered: {
        type: String,
        trim: true,
        default: '',
      },
      safetyNotes: {
        type: String,
        trim: true,
        default: '',
      },
      encouragementAndNextStep: {
        type: String,
        trim: true,
        default: '',
      },
    },
    reportMeta: {
      generatedAt: Date,
      generationModel: {
        type: String,
        trim: true,
        default: '',
      },
      generationStatus: {
        type: String,
        enum: ['pending', 'success', 'fallback', 'failed'],
        default: 'pending',
      },
    },
    visibility: {
      type: String,
      enum: ['user_only'],
      default: 'user_only',
    },
  },
  { timestamps: true },
);

aiTherapySessionSchema.index({ user: 1, startedAt: -1 });
aiTherapySessionSchema.index({ user: 1, endedAt: -1 });

module.exports = mongoose.model('AiTherapySession', aiTherapySessionSchema);
