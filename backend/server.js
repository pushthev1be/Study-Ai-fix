const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
const backendTesting = require('./testing-middleware');
require('dotenv').config();

const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const { startMongoDB } = require('./start-mongodb');

// Token tracking and cost optimization for OpenAI API
const tokenUsage = {
    totalTokens: 0,
    totalCost: 0,
    sessions: new Map() // Track per-session usage
};

// GPT-4o-mini pricing (per 1M tokens) - 50% less for cached tokens
const PRICING = {
    'gpt-4o-mini': {
        input: 0.15,  // $0.15 per 1M input tokens
        output: 0.60, // $0.60 per 1M output tokens
        cached_input: 0.075 // 50% discount for cached prompt tokens (>1024 tokens automatically cached by OpenAI)
    }
};

// Helper to calculate token cost with proper cached token support
function calculateCost(model, usage) {
    const pricing = PRICING[model] || PRICING['gpt-4o-mini'];
    
    // Check for cached tokens in the response from OpenAI
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
    const regularInputTokens = usage.prompt_tokens - cachedTokens;
    
    // Calculate costs: cached tokens get 50% discount
    const cachedCost = (cachedTokens / 1000000) * pricing.cached_input;
    const inputCost = (regularInputTokens / 1000000) * pricing.input;
    const outputCost = (usage.completion_tokens / 1000000) * pricing.output;
    
    return cachedCost + inputCost + outputCost;
}

// Helper to track token usage with accurate cost calculation
function trackTokenUsage(sessionId, model, usage) {
    if (!usage) return;
    
    const cost = calculateCost(model, usage);
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
    
    tokenUsage.totalTokens += usage.total_tokens;
    tokenUsage.totalCost += cost;
    
    if (sessionId) {
        const session = tokenUsage.sessions.get(sessionId) || { tokens: 0, cost: 0, cachedTokens: 0 };
        session.tokens += usage.total_tokens;
        session.cost += cost;
        session.cachedTokens += cachedTokens;
        tokenUsage.sessions.set(sessionId, session);
    }
    
    const cacheInfo = cachedTokens > 0 ? ` (${cachedTokens} cached)` : '';
    console.log(`💰 Token usage: ${usage.total_tokens} tokens${cacheInfo}, $${cost.toFixed(4)} cost`);
    return { tokens: usage.total_tokens, cost, cachedTokens };
}

// Token estimation helper (approximately 1 token = 4 characters)
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

// Truncate text to approximately maxTokens
function truncateToTokenLimit(text, maxTokens = 2000) {
    const estimatedTokens = estimateTokens(text);
    if (estimatedTokens <= maxTokens) {
        return text;
    }
    
    // Truncate to approximately maxTokens (using 4 chars per token estimate)
    const maxChars = maxTokens * 4;
    return text.substring(0, maxChars) + '\n[Content truncated for token optimization]';
}

// Schema max tokens configuration
const SCHEMA_MAX_TOKENS = {
    'questions': 3000,
    'flashcards': 1500,
    'batch_flashcards': 2000,
    'simple_flashcards': 1200,
    'batch_questions': 4000,
    'template_questions': 3500,
    'summary': 800,
    'knowledgeGaps': 600,
    'studyPlan': 1000,
    'default': 1500
};

// Add Ajv for JSON schema validation
const Ajv = require('ajv');
const ajv = new Ajv();

// JSON Schemas for validation
const questionSetSchema = {
    type: "object",
    required: ["title", "difficulty", "description", "multipleChoice", "shortAnswer", "essay"],
    additionalProperties: false,
    properties: {
        title: { type: "string" },
        difficulty: { type: "string", enum: ["Easy", "Medium", "Hard"] },
        description: { type: "string" },
        multipleChoice: {
            type: "array",
            items: {
                type: "object",
                required: ["question", "options", "correctAnswer", "explanation", "difficulty", "topic"],
                additionalProperties: false,
                properties: {
                    question: { type: "string" },
                    options: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 4 },
                    correctAnswer: { type: "string" },
                    explanation: { type: "string" },
                    difficulty: { type: "number", minimum: 1, maximum: 5 },
                    topic: { type: "string" },
                    learningObjective: { type: "string" },
                    hints: { type: "array", items: { type: "string" } },
                    commonMistakes: { type: "array", items: { type: "string" } },
                    timeEstimate: { type: "string" }
                }
            }
        },
        shortAnswer: {
            type: "array",
            items: {
                type: "object",
                required: ["question", "sampleAnswer", "points"],
                additionalProperties: false,
                properties: {
                    question: { type: "string" },
                    sampleAnswer: { type: "string" },
                    points: { type: "number" },
                    rubric: { type: "string" },
                    keyPoints: { type: "array", items: { type: "string" } }
                }
            }
        },
        essay: {
            type: "array",
            items: {
                type: "object",
                required: ["question", "guidelines", "points"],
                additionalProperties: false,
                properties: {
                    question: { type: "string" },
                    guidelines: { type: "string" },
                    points: { type: "number" },
                    structure: { type: "string" },
                    resources: { type: "array", items: { type: "string" } }
                }
            }
        }
    }
};

const flashcardBatchSchema = {
    type: "object",
    required: ["flashcards"],
    additionalProperties: false,
    properties: {
        flashcards: {
            type: "array",
            items: {
                type: "object",
                required: ["term", "definition", "visualDescription", "mnemonic", "multipleExamples", "commonMisconceptions", "connections", "practiceQuestion", "memoryTips", "category", "difficulty", "importance"],
                additionalProperties: false,
                properties: {
                    term: { type: "string" },
                    definition: { type: "string" },
                    visualDescription: { type: "string" },
                    mnemonic: { type: "string" },
                    multipleExamples: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
                    commonMisconceptions: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
                    connections: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
                    practiceQuestion: { type: "string" },
                    memoryTips: { type: "string" },
                    category: { type: "string" },
                    difficulty: { type: "number", minimum: 1, maximum: 5 },
                    importance: { type: "number", minimum: 1, maximum: 5 }
                }
            },
            minItems: 3,
            maxItems: 7
        }
    }
};

// Optimized simple flashcard schema for flip cards
const simpleFlashcardSchema = {
    type: "object",
    required: ["flashcards"],
    additionalProperties: false,
    properties: {
        flashcards: {
            type: "array",
            items: {
                type: "object",
                required: ["front", "back"],
                additionalProperties: false,
                properties: {
                    front: { type: "string" }, // Critical knowledge/term
                    back: { type: "string" }  // Concise explanation
                }
            },
            minItems: 10,
            maxItems: 10
        }
    }
};

// Batch question schema for 20 questions at once
const batchQuestionSchema = {
    type: "object",
    required: ["questions"],
    additionalProperties: false,
    properties: {
        questions: {
            type: "array",
            items: {
                type: "object",
                required: ["question", "options", "correctAnswer", "explanation"],
                additionalProperties: false,
                properties: {
                    question: { type: "string" },
                    options: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
                    correctAnswer: { type: "string" },
                    explanation: { type: "string" }
                }
            },
            minItems: 20,
            maxItems: 20
        }
    }
};

// Template question schema for new 7+4 format
const templateQuestionSchema = {
    type: "object",
    required: ["questions"],
    additionalProperties: false,
    properties: {
        questions: {
            type: "array",
            items: {
                type: "object",
                required: ["question", "options", "correctAnswer", "explanation", "difficulty", "topic", "type", "learningObjective", "hints", "commonMistakes", "timeEstimate"],
                additionalProperties: false,
                properties: {
                    question: { type: "string" },
                    options: {
                        type: "array",
                        items: { type: "string" },
                        minItems: 3,
                        maxItems: 4
                    },
                    correctAnswer: { type: "string" },
                    explanation: { type: "string" },
                    difficulty: { type: "number", minimum: 1, maximum: 5 },
                    topic: { type: "string" },
                    type: { type: "string", enum: ["direct", "twisted"] },
                    learningObjective: { type: "string" },
                    hints: {
                        type: "array",
                        items: { type: "string" }
                    },
                    commonMistakes: {
                        type: "array", 
                        items: { type: "string" }
                    },
                    timeEstimate: { type: "string" }
                }
            }
        }
    }
};

// Compile schemas for faster validation
const validateQuestionSet = ajv.compile(questionSetSchema);
const validateFlashcardBatch = ajv.compile(flashcardBatchSchema);
const validateTemplateQuestions = ajv.compile(templateQuestionSchema);
const validateBatchQuestions = ajv.compile(batchQuestionSchema);
const validateSimpleFlashcards = ajv.compile(simpleFlashcardSchema);

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

let db;
let mongoClient;

// In-memory cache for active question sessions
const questionSessionCache = new Map();

const getMongoClient = (uri) => new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });

function isLocalUri(uri) { 
    return !!uri && /^mongodb:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(uri); 
}

async function initializeDatabase() {
    if (!db) {
        if (app.locals && app.locals.testDb) {
            db = app.locals.testDb;
        } else {
            let uri = process.env.MONGODB_URI;
            const forceMemory = process.env.MONGODB_USE_MEMORY === '1';
            
            // Force Memory Server if no URI, localhost URI, or forced
            if (forceMemory || !uri || isLocalUri(uri)) {
                console.log('🔄 Using in-memory MongoDB (no/localhost URI detected)');
                const { startMongoDB } = require('./start-mongodb');
                uri = await startMongoDB();
                process.env.MONGODB_URI = uri; // override stale value
            }
            
            try {
                console.log('🔗 Attempting to connect to MongoDB:', isLocalUri(uri) ? '(local)' : '(external)');
                mongoClient = getMongoClient(uri);
                await mongoClient.connect();
            } catch (err) {
                console.warn('⚠️ Connect failed, falling back to in-memory MongoDB...', err.message);
                const { startMongoDB } = require('./start-mongodb');
                uri = await startMongoDB();
                process.env.MONGODB_URI = uri;
                mongoClient = getMongoClient(uri);
                await mongoClient.connect();
            }
            
            // Test the connection with a ping
            db = mongoClient.db('studymaster');
            await db.command({ ping: 1 });
            console.log('🏓 Database ping successful');
            
            app.locals.mongoClient = mongoClient;
            console.log('✅ Connected to MongoDB successfully');
        }

        // Create indexes
        await db.collection('files').createIndex({ userId: 1 });
        await db.collection('files').createIndex({ embedding: 1 });
        await db.collection('flashcards').createIndex({ userId: 1, nextReview: 1 });
        await db.collection('users').createIndex({ email: 1 }, { unique: true });
        
        // New indexes for question batching system
        await db.collection('study_sessions').createIndex({ userId: 1, topicKey: 1 });
        await db.collection('study_sessions').createIndex({ createdAt: -1 });
        await db.collection('question_batches').createIndex({ sessionId: 1, batchNumber: 1 });
        await db.collection('question_batches').createIndex({ sessionId: 1, 'questions.status': 1 });
        
        console.log('✅ Database indexes created');
    }
    return db;
}

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        // Allow all Replit domains and local development
        const allowedOrigins = [
            'http://localhost:8080',
            'http://127.0.0.1:8080',
            'http://localhost:5000',
            'http://127.0.0.1:5000',
            'https://study-ai-2.onrender.com'
        ];

        // Allow any replit.dev or repl.co domain
        if (origin && (origin.includes('.replit.dev') || origin.includes('.repl.co') || origin.includes('janeway'))) {
            return callback(null, true);
        }

        // Allow configured origins
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        // Allow all origins for development (can be restricted in production)
        callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Testing Middleware
app.use(backendTesting.requestLogger());

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Enhanced CORS configuration
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        // Allow all Replit domains and local development
        const allowedOrigins = [
            'http://localhost:8080',
            'http://127.0.0.1:8080',
            'http://localhost:5000',
            'http://127.0.0.1:5000',
            'https://study-ai-2.onrender.com'
        ];

        // Allow any replit.dev or repl.co domain
        if (origin && (origin.includes('.replit.dev') || origin.includes('.repl.co') || origin.includes('janeway'))) {
            return callback(null, true);
        }

        // Allow configured origins
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        // Allow all origins for development (can be restricted in production)
        callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

// Handle proxied requests from frontend
app.use((req, res, next) => {
    // Log incoming requests for debugging
    console.log(`${req.method} ${req.path} - Origin: ${req.get('Origin')} - Host: ${req.get('Host')}`);

    // Handle Replit proxy routing
    const host = req.get('Host');
    if (host && host.includes('janeway') && !req.path.startsWith('/api') && !req.path.startsWith('/health') && !req.path.startsWith('/test-connection')) {
        // This might be a request meant for the frontend, but hitting the backend
        // Send a helpful response
        if (req.path === '/' && req.method === 'GET') {
            return res.json({
                message: 'StudyMaster AI Backend API',
                status: 'running',
                frontend_url: `https://${host.replace(':3000', ':5000')}`,
                note: 'This is the backend server. The frontend is available at the URL above.'
            });
        }
    }

    next();
});

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }


    if (!process.env.JWT_SECRET) {
        return res.status(500).json({ error: 'Server configuration error' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.userId = user.userId;
        next();
    });
};

const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = 'uploads/';
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /\.(pdf|txt|doc|docx|md)$/i;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype) || file.mimetype === 'text/plain';

        if (extname || mimetype) {
            return cb(null, true);
        } else {
            cb(new Error('Only PDF, TXT, DOC, and DOCX files are allowed'));
        }
    }
});

async function extractTextFromFile(filePath, mimeType) {
    try {
        console.log(`Extracting text from file: ${filePath}, mimeType: ${mimeType}`);

        if (mimeType === 'application/pdf') {
            const dataBuffer = await fs.readFile(filePath);
            const data = await pdfParse(dataBuffer);
            if (!data.text || data.text.trim().length === 0) {
                throw new Error('PDF file appears to be empty or contains no extractable text');
            }
            console.log(`Extracted ${data.text.length} characters from PDF`);
            return data.text;
        } else if (mimeType === 'text/plain') {
            const text = await fs.readFile(filePath, 'utf-8');
            if (!text || text.trim().length === 0) {
                throw new Error('Text file is empty');
            }
            console.log(`Extracted ${text.length} characters from text file`);
            return text;
        } else if (mimeType.includes('word') || mimeType.includes('document') ||
                   mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
                   mimeType === 'application/msword') {
            const result = await mammoth.extractRawText({ path: filePath });
            if (!result.value || result.value.trim().length === 0) {
                throw new Error('Word document appears to be empty or contains no extractable text');
            }
            console.log(`Extracted ${result.value.length} characters from Word document`);
            return result.value;
        } else {
            throw new Error(`Unsupported file type: ${mimeType}. Only PDF, TXT, DOC, and DOCX files are allowed.`);
        }
    } catch (error) {
        console.error(`Error extracting text from ${filePath}:`, error);
        throw new Error(`Failed to extract text from file: ${error.message}`);
    }
}

async function generateEmbedding(text) {
    try {
        // Try OpenAI first with more accessible model
        const response = await openai.embeddings.create({
            model: "text-embedding-3-large", // Allowed embedding model
            input: text.substring(0, 8000)
        });
        return response.data[0].embedding;
    } catch (error) {
        console.error('Error generating embedding:', error);
        // Fallback to simple text hashing for basic similarity
        return generateSimpleEmbedding(text);
    }
}

// Simple embedding fallback using text hashing
function generateSimpleEmbedding(text) {
    // Create a simple 1536-dimension vector based on text characteristics
    const embedding = new Array(1536).fill(0);
    const words = text.toLowerCase().split(/\s+/);

    // Hash-based embedding simulation
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const hash = word.split('').reduce((a, b) => {
            a = ((a << 5) - a) + b.charCodeAt(0);
            return a & a;
        }, 0);

        const index = Math.abs(hash) % embedding.length;
        embedding[index] += 1 / words.length;
    }

    console.log('Using fallback embedding for text analysis');
    return embedding;
}

// Request coalescing cache to prevent duplicate processing
const inflightRequests = new Map();
const contentCache = new Map();

// Generate cache key for request deduplication
function generateRequestKey(userId, fileIds, mode, textLength) {
    return `${userId}:${JSON.stringify(fileIds.sort())}:${mode}:${textLength}`;
}

// Optimized retry logic with jitter and better error handling
async function retryWithBackoff(operation, maxRetries = 1, baseDelay = 150) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            
            // Don't retry on 4xx errors except 408, 429
            const status = error.response?.status || error.status;
            if (status >= 400 && status < 500 && ![408, 429].includes(status)) {
                throw error;
            }

            // Add jitter to prevent thundering herd
            const jitter = Math.random() * 0.3 + 0.85; // 85-115% of base delay
            const delay = Math.min(baseDelay * Math.pow(1.5, attempt) * jitter, 2000);
            console.log(`❌ Attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Core API call function with validation using structured JSON schema
async function makeValidatedAPICall(prompt, schema, validator, type, batchName = '', sessionId = null) {
    const operation = async () => {
        const startTime = Date.now();
        
        // Token-aware prompt truncation (target ~2000 tokens for prompt)
        const optimizedPrompt = truncateToTokenLimit(prompt, 2000);
        
        // Get max tokens for this schema type
        const maxTokens = SCHEMA_MAX_TOKENS[type] || SCHEMA_MAX_TOKENS.default;
        
        const response = await Promise.race([
            openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: "You are an expert educator. Generate content strictly according to the provided JSON schema. Be concise and efficient."
                    },
                    {
                        role: "user",
                        content: optimizedPrompt
                    }
                ],
                temperature: 0.3, // Optimized for balance of speed and quality
                max_tokens: maxTokens, // Dynamic based on content type
                response_format: { 
                    type: "json_schema", 
                    json_schema: { 
                        name: "response", 
                        schema: schema,
                        strict: true 
                    } 
                }
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`OpenAI request timeout after 50 seconds for ${type}${batchName ? ' ' + batchName : ''}`)), 50000)
            )
        ]);

        const endTime = Date.now();
        console.log(`⚡ OpenAI API call for ${type}${batchName ? ' ' + batchName : ''} completed in ${endTime - startTime}ms`);

        const rawContent = response.choices[0].message.content;

        if (!rawContent || rawContent.trim() === '') {
            throw new Error(`Empty response from OpenAI for ${type}${batchName ? ' ' + batchName : ''}`);
        }

        // Parse JSON with better error handling
        let parsed;
        try {
            parsed = JSON.parse(rawContent);
        } catch (parseError) {
            console.error(`❌ JSON parsing failed for ${type}${batchName ? ' ' + batchName : ''}:`, parseError.message);
            console.error('Raw content:', rawContent.substring(0, 500) + '...');
            throw new Error(`JSON parsing failed: ${parseError.message}`);
        }

        // Validate against schema (should always pass with strict: true)
        if (!validator(parsed)) {
            console.error(`❌ Schema validation failed for ${type}${batchName ? ' ' + batchName : ''}:`, validator.errors);
            throw new Error(`Schema validation failed: ${validator.errors.map(e => e.message).join(', ')}`);
        }

        // Track token usage with proper session tracking
        if (response.usage) {
            trackTokenUsage(sessionId, 'gpt-4o-mini', response.usage);
        }
        
        console.log(`✅ Successfully generated and validated ${type}${batchName ? ' ' + batchName : ''} in ${endTime - startTime}ms`);
        return parsed;
    };

    return await retryWithBackoff(operation, 2, 200); // Increased retries and delay for better reliability
}

// Generate batch of 20 questions at once for Keep Going feature
async function generateQuestionBatch(text, sessionContext = null) {
    console.log('🎯 Generating batch of 20 questions...');
    
    // Use context summary if available, otherwise create concise summary
    const contextText = sessionContext?.contextSummary || text.substring(0, 1500);
    const previousTopics = sessionContext?.previousTopics || [];
    
    const prompt = `Generate exactly 20 multiple choice questions. Keep it simple and fast.

Content: ${contextText}

${previousTopics.length > 0 ? `Avoid these topics already covered: ${previousTopics.join(', ')}` : ''}

Generate diverse questions covering different aspects.`;

    const operation = async () => {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Fast model
            messages: [
                {
                    role: "system",
                    content: "Generate exactly 20 multiple choice questions. Each with 4 options and clear explanation."
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.3, // Lower for speed
            max_tokens: 4000,
            response_format: { 
                type: "json_schema",
                json_schema: {
                    name: "question_batch",
                    strict: true,
                    schema: batchQuestionSchema
                }
            }
        });

        const content = JSON.parse(response.choices[0].message.content);
        
        // Track token usage for batch generation
        if (response.usage) {
            trackTokenUsage(sessionContext?.sessionId, 'gpt-4o-mini', response.usage);
        }
        
        return content.questions;
    };

    return await retryWithBackoff(operation, 2, 200);
}

// Generate template-based questions: 7 direct + 4 twisted 
async function generateQuestionsBatched(text, sessionId = null) {
    console.log('🔄 Starting optimized template-based questions generation (7 direct + 4 twisted)...');

    // Use token-aware truncation for optimal processing
    const optimizedText = truncateToTokenLimit(text, 750); // ~750 tokens for faster processing

    // Optimized concise prompt for direct questions
    const directPrompt = `Generate 7 questions from key concepts in this content:

${optimizedText}

Return JSON:
{
    "questions": [
        {
            "question": "Question text",
            "options": ["A", "B", "C", "D"],
            "correctAnswer": "A",
            "explanation": "Brief explanation",
            "difficulty": 2,
            "topic": "Topic",
            "type": "direct",
            "learningObjective": "Learning goal",
            "hints": ["Hint"],
            "commonMistakes": ["Mistake"],
            "timeEstimate": "2 minutes"
        }
    ]
}`;

    // Optimized concise prompt for application questions
    const twistedPrompt = `Generate 4 application questions using concepts from this content in new scenarios:

${optimizedText}

Return JSON:
{
    "questions": [
        {
            "question": "Application question",
            "options": ["A", "B", "C", "D"],
            "correctAnswer": "A",
            "explanation": "Brief connection to content",
            "difficulty": 3,
            "topic": "Application",
            "type": "twisted",
            "learningObjective": "Apply to new situation",
            "hints": ["Hint"],
            "commonMistakes": ["Mistake"],
            "timeEstimate": "3 minutes"
        }
    ]
}`;

    try {
        // Generate direct and twisted questions in parallel with optimized timeout
        console.log('🔄 Generating 7 direct + 4 twisted questions in parallel (optimized)...');
        const startTime = Date.now();
        
        const [directResult, twistedResult] = await Promise.all([
            makeValidatedAPICall(directPrompt, templateQuestionSchema, validateTemplateQuestions, 'template_questions', 'direct', sessionId),
            makeValidatedAPICall(twistedPrompt, templateQuestionSchema, validateTemplateQuestions, 'template_questions', 'twisted', sessionId)
        ]);

        const endTime = Date.now();
        console.log(`⚡ Parallel generation completed in ${endTime - startTime}ms`);

        // Combine into single set with template structure
        const templateQuestions = {
            title: "Template Practice Questions",
            description: "7 content-focused + 4 creative application questions",
            totalQuestions: 11,
            contentQuestions: directResult.questions || [],
            twistedQuestions: twistedResult.questions || [],
            allQuestions: [...(directResult.questions || []), ...(twistedResult.questions || [])]
        };

        console.log(`✅ Generated template questions in parallel: ${templateQuestions.contentQuestions.length} direct + ${templateQuestions.twistedQuestions.length} twisted = ${templateQuestions.allQuestions.length} total`);
        return templateQuestions;

    } catch (error) {
        console.error('❌ Failed to generate template questions:', error.message);
        throw new Error(`Failed to generate template questions: ${error.message}`);
    }
}

// Generate exactly 5 crucial flashcards (template approach)
async function generateFlashcardsBatched(text, sessionId = null) {
    console.log('🔄 Starting crucial flashcards generation (template: 5 cards)...');

    const prompt = `Analyze this content and identify the 5 MOST CRUCIAL concepts that students must master. Create exactly 5 premium flashcards for these essential concepts.

Content: ${truncateToTokenLimit(text, 1500)}

Selection criteria for crucial concepts:
- Fundamental principles that everything else builds upon
- Key definitions students must know by heart  
- Core processes or mechanisms central to the topic
- Essential knowledge for understanding advanced concepts
- Most commonly tested or referenced material

Each flashcard must have ALL these elements:
- term: The most crucial concept name
- definition: Clear, comprehensive explanation with context
- visualDescription: Vivid mental imagery for memory retention
- mnemonic: Creative memory device or acronym
- multipleExamples: Array of exactly 3 concrete, relatable examples
- commonMisconceptions: Array of exactly 3 frequent student mistakes
- connections: Array of exactly 3 related concepts within the material
- practiceQuestion: Self-assessment question with clear answer
- memoryTips: Specific study strategies for this concept
- category: Subject area classification
- difficulty: 1-5 scale (1=basic, 5=advanced)
- importance: 5 (all should be maximum importance)

Return ONLY this JSON structure:
{
    "flashcards": [
        {
            "term": "Crucial Concept Name",
            "definition": "Comprehensive definition with full context",
            "visualDescription": "Rich mental imagery description", 
            "mnemonic": "Memorable device or acronym",
            "multipleExamples": ["Concrete example 1", "Relatable example 2", "Real-world example 3"],
            "commonMisconceptions": ["Frequent mistake 1", "Common confusion 2", "Typical error 3"],
            "connections": ["Related concept 1", "Connected idea 2", "Linked principle 3"],
            "practiceQuestion": "Self-test question about this concept",
            "memoryTips": "Specific study strategy for mastering this",
            "category": "Subject Area",
            "difficulty": 3,
            "importance": 5
        }
    ]
}`;

    try {
        const result = await makeValidatedAPICall(prompt, flashcardBatchSchema, validateFlashcardBatch, 'batch_flashcards', 'crucial', sessionId);

        console.log(`✅ Generated ${result.flashcards.length} crucial flashcards`);
        return { flashcards: result.flashcards };

    } catch (error) {
        console.error('❌ Failed to generate crucial flashcards:', error.message);
        throw new Error(`Failed to generate crucial flashcards: ${error.message}`);
    }
}

// Main function that routes to batched or regular generation
// Cache cleanup - remove expired entries every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of contentCache.entries()) {
        if (now - value.timestamp > 300000) { // 5 minute TTL
            contentCache.delete(key);
        }
    }
}, 600000);

async function generateStudyContent(text, type, options = {}) {
    const sessionId = options.sessionId || null;
    
    if (type === 'questions') {
        return await generateQuestionsBatched(text, sessionId);
    } else if (type === 'flashcards') {
        // Generate 10 simple flashcards
        console.log('🔄 Generating 10 simple flashcards...');
        
        const prompt = `Create exactly 10 simple flashcards. Each with:
- Front: Critical term or concept (5-10 words)
- Back: Clear explanation (20-40 words)

Content: ${text.substring(0, 2000)}

Focus on the most important concepts only.`;

        const operation = async () => {
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: "Create simple, clear flashcards for studying."
                    },
                    { role: "user", content: prompt }
                ],
                temperature: 0.3,
                max_tokens: SCHEMA_MAX_TOKENS.simple_flashcards || 1200,
                response_format: { 
                    type: "json_schema",
                    json_schema: {
                        name: "flashcard_batch",
                        strict: true,
                        schema: simpleFlashcardSchema
                    }
                }
            });

            const content = JSON.parse(response.choices[0].message.content);
            return content.flashcards;
        };

        try {
            const flashcards = await retryWithBackoff(operation, 2, 200);
            
            // Track token usage for simple flashcards
            if (options.sessionId) {
                // Note: We don't have the usage data here, so we estimate
                const estimatedTokens = estimateTokens(prompt) + 1200;
                console.log(`💰 Estimated token usage for simple flashcards: ${estimatedTokens} tokens`);
            }
            
            console.log(`✅ Generated ${flashcards.length} simple flashcards`);
            return { flashcards };
        } catch (error) {
            console.error(`❌ Failed to generate flashcards:`, error.message);
            throw new Error(`Failed to generate flashcards: ${error.message}`);
        }
    }

    // For other types, use existing single-call approach
    const prompts = {
        summary: `Create a simple study summary with 5 key bullet points.

            Content: ${text.substring(0, 3000)}

            Return ONLY valid JSON in this exact format:
            {
                "bullets": [
                    "Key point 1 (max 20 words)",
                    "Key point 2 (max 20 words)",
                    "Key point 3 (max 20 words)",
                    "Key point 4 (max 20 words)",
                    "Key point 5 (max 20 words)"
                ],
                "overview": "Brief overview in 1-2 sentences",
                "difficulty": "Beginner/Intermediate/Advanced"
            }`,

        knowledgeGaps: `Analyze this content and identify the prerequisite knowledge and potential difficult areas.

            Content: ${text.substring(0, 8000)}

            Return ONLY valid JSON in this exact format:
            {
                "prerequisites": ["item1", "item2"],
                "difficultConcepts": ["concept1", "concept2"],
                "commonMisconceptions": ["misconception1"],
                "studyPriorities": ["priority1", "priority2"]
            }`,

        studyPlan: `Create a detailed study plan for mastering this content in ${options.days || 7} days.

            Content: ${text.substring(0, 8000)}

            Return ONLY valid JSON in this exact format:
            {
                "studyPlan": {
                    "day1": {
                        "tasks": ["task1", "task2"],
                        "timeRequired": "2 hours",
                        "topics": ["topic1"],
                        "reviewItems": ["item1"]
                    }
                }
            }`
    };

    try {
        console.log(`Generating ${type} with OpenAI...`);

        const response = await Promise.race([
            openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: "You are an expert educator. Generate content strictly according to the requested JSON format."
                    },
                    {
                        role: "user",
                        content: prompts[type]
                    }
                ],
                temperature: 0.4,
                max_tokens: 3000,
                response_format: { type: "json_object" }
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`OpenAI request timeout after 30 seconds`)), 30000)
            )
        ]);

        const rawContent = response.choices[0].message.content;

        if (!rawContent || rawContent.trim() === '') {
            throw new Error(`Empty response from OpenAI for ${type}`);
        }

        // Parse JSON directly - minimal cleanup for better reliability
        const parsed = JSON.parse(rawContent);
        console.log(`✅ Successfully generated ${type}`);
        return parsed;

    } catch (error) {
        console.error(`❌ Error generating ${type}:`, error.message);

        if (error.message.includes('API key')) {
            throw new Error(`OpenAI API key issue: ${error.message}`);
        } else if (error.message.includes('rate limit')) {
            throw new Error(`OpenAI rate limit exceeded: ${error.message}`);
        } else if (error.message.includes('timeout')) {
            throw new Error(`OpenAI request timeout: ${error.message}`);
        }

        // Return proper error instead of fallback
        throw new Error(`Failed to generate ${type}: ${error.message}`);
    }
}

function getFallbackContent(type) {
    const fallbacks = {
        summary: {
            overview: "Content analysis is being processed. Please try again.",
            keyPoints: ["Content uploaded successfully", "Analysis in progress"],
            definitions: {},
            relationships: [],
            recommendations: ["Please refresh and try again in a moment."]
        },
        questions: {
            multipleChoice: [
                {
                    question: "What is the main topic of the uploaded content?",
                    options: ["Option A", "Option B", "Option C", "Option D"],
                    correctAnswer: "Option A",
                    explanation: "Review the uploaded material.",
                    difficulty: 1,
                    topic: "General"
                }
            ],
            shortAnswer: [
                {
                    question: "Summarize the main concept in your own words.",
                    sampleAnswer: "Answers will vary based on content.",
                    points: 5
                }
            ],
            essay: [
                {
                    question: "Discuss the key themes presented in the material.",
                    guidelines: "Include introduction, main points, and conclusion.",
                    points: 20
                }
            ]
        },
        flashcards: {
            flashcards: [
                {
                    term: "Electric Current",
                    definition: "The rate of flow of electric charge, measured in amperes (A). Formula: I = dq/dt",
                    visualDescription: "Think of electric current like water flowing through a pipe - the amount of charge flowing per second.",
                    mnemonic: "Current = Charge per Time (I = dq/dt)",
                    multipleExamples: ["Lightning strike", "Battery powering a flashlight", "Electric motor running"],
                    commonMisconceptions: ["Current is consumed by devices", "Current and voltage are the same thing"]
                },
                {
                    term: "Ohm's Law",
                    definition: "The relationship between voltage, current, and resistance: V = IR",
                    visualDescription: "Voltage is like water pressure, current is flow rate, resistance is pipe width.",
                    mnemonic: "Voltage equals I times R (V = IR)",
                    multipleExamples: ["Calculating voltage drop across a resistor", "Finding current through a circuit", "Determining resistance value"],
                    commonMisconceptions: ["Ohm's Law applies to all materials", "Resistance doesn't change with temperature"]
                },
                {
                    term: "Electrical Resistance",
                    definition: "Opposition to current flow, measured in ohms (Ω). Formula: R = ρL/A",
                    visualDescription: "Like friction in a pipe - wider pipes (more area) have less resistance.",
                    mnemonic: "Resistance opposes current flow",
                    multipleExamples: ["Wire heating up with current", "Dimmer switch controlling brightness", "Fuse protecting circuits"],
                    commonMisconceptions: ["Thicker wires have more resistance", "Resistance is always constant"]
                },
                {
                    term: "Electric Power",
                    definition: "Rate of electrical energy transfer: P = VI = I²R = V²/R, measured in watts (W)",
                    visualDescription: "Power is how fast electrical energy is used or delivered.",
                    mnemonic: "Power = Volts × Amps (P = VI)",
                    multipleExamples: ["Light bulb consuming 60W", "Electric heater using 1500W", "Phone charger at 5W"],
                    commonMisconceptions: ["Power and energy are the same", "Higher voltage always means more power"]
                },
                {
                    term: "Kirchhoff's Current Law (KCL)",
                    definition: "The sum of currents entering a node equals the sum of currents leaving: Σ I_in = Σ I_out",
                    visualDescription: "Like water at a junction - what flows in must equal what flows out.",
                    mnemonic: "Current In = Current Out at any node",
                    multipleExamples: ["Junction in a circuit board", "Parallel branch splitting", "Wire connection point"],
                    commonMisconceptions: ["Current gets used up in circuits", "KCL doesn't apply to AC circuits"]
                },
                {
                    term: "Kirchhoff's Voltage Law (KVL)",
                    definition: "The sum of voltage rises equals the sum of voltage drops around any closed loop: Σ V = 0",
                    visualDescription: "Like hiking - total elevation gain equals total elevation loss in a complete loop.",
                    mnemonic: "Voltage rises equal voltage drops in any loop",
                    multipleExamples: ["Series circuit analysis", "Complex network solving", "Battery and resistor loop"],
                    commonMisconceptions: ["KVL only works for DC circuits", "Voltage is consumed by components"]
                },
                {
                    term: "Series Resistors",
                    definition: "Resistors connected end-to-end. Total resistance: R_total = R1 + R2 + R3 + ...",
                    visualDescription: "Like obstacles in a single path - each adds to the total resistance.",
                    mnemonic: "Series resistors ADD up",
                    multipleExamples: ["Christmas lights in series", "Voltage divider circuit", "Current limiting resistors"],
                    commonMisconceptions: ["Current splits between series resistors", "Series increases current"]
                },
                {
                    term: "Parallel Resistors",
                    definition: "Resistors connected side-by-side. Formula: 1/R_total = 1/R1 + 1/R2 + 1/R3 + ...",
                    visualDescription: "Like multiple paths for water - more paths means less total resistance.",
                    mnemonic: "Parallel resistors: 1/R = 1/R1 + 1/R2",
                    multipleExamples: ["House electrical outlets", "Car headlights", "Parallel LED arrays"],
                    commonMisconceptions: ["Parallel resistors add like series", "All parallel resistors have same current"]
                },
                {
                    term: "Capacitance",
                    definition: "Ability to store electric charge: C = Q/V. For parallel plates: C = εA/d",
                    visualDescription: "Like a bucket storing water - larger area stores more charge.",
                    mnemonic: "Capacitance stores Charge per Volt",
                    multipleExamples: ["Flash camera capacitor", "Power supply smoothing", "Timing circuits"],
                    commonMisconceptions: ["Capacitors store current", "Bigger capacitors always store more energy"]
                },
                {
                    term: "Electric Field",
                    definition: "Force per unit charge: E = F/q. Also E = V/d for uniform fields. Units: N/C or V/m",
                    visualDescription: "Invisible force field around charges - like gravity around mass.",
                    mnemonic: "Electric field = Force per charge",
                    multipleExamples: ["Static electricity", "Van de Graaff generator", "Lightning formation"],
                    commonMisconceptions: ["Electric field only exists with current", "Field lines cross each other"]
                },
                {
                    term: "Coulomb's Law",
                    definition: "Force between charges: F = k(q1×q2)/r². k = 1/(4πε₀) ≈ 9×10⁹ N⋅m²/C²",
                    visualDescription: "Like gravity but for electric charges - closer charges feel stronger force.",
                    mnemonic: "Force varies as 1/distance²",
                    multipleExamples: ["Attraction between proton and electron", "Repulsion between like charges", "Electrostatic precipitator"],
                    commonMisconceptions: ["Force is always attractive", "Distance doesn't matter much"]
                },
                {
                    term: "Electrical Resistivity",
                    definition: "Material property: ρ = RA/L. Temperature dependent: ρ(T) = ρ₀[1 + α(T-T₀)]",
                    visualDescription: "Like the 'thickness' of honey - some materials resist current flow more.",
                    mnemonic: "Resistivity = Resistance × Area / Length",
                    multipleExamples: ["Copper wire (low ρ)", "Rubber insulation (high ρ)", "Semiconductor doping"],
                    commonMisconceptions: ["Resistivity and resistance are the same", "All metals have same resistivity"]
                }
            ]
        },
        knowledgeGaps: {
            prerequisites: ["Basic understanding of the subject"],
            difficultConcepts: ["Advanced topics in the material"],
            commonMisconceptions: ["Content-specific misconceptions"],
            studyPriorities: ["Focus on main concepts first"]
        },
        studyPlan: {
            studyPlan: {
                day1: {
                    tasks: ["Review uploaded content", "Identify key concepts"],
                    timeRequired: "2 hours",
                    topics: ["Introduction"],
                    reviewItems: ["Basic concepts"]
                }
            }
        }
    };

    return fallbacks[type] || { error: "Fallback content not available" };
}

function calculateSpacedRepetition(quality, repetitions, easeFactor, interval) {
    if (quality < 3) {
        repetitions = 0;
        interval = 1;
    } else {
        if (repetitions === 0) {
            interval = 1;
        } else if (repetitions === 1) {
            interval = 6;
        } else {
            interval = Math.round(interval * easeFactor);
        }
        repetitions += 1;
    }

    easeFactor = Math.max(1.3, easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));

    return {
        repetitions,
        interval,
        easeFactor,
        nextReview: new Date(Date.now() + interval * 24 * 60 * 60 * 1000)
    };
}

app.get('/', (req, res) => {
    res.json({
        message: 'StudyMaster AI Backend API',
        status: 'running',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            auth: '/api/auth/*',
            upload: '/api/upload',
            generate: '/api/generate',
            chat: '/api/chat',
            spacedRepetition: '/api/spaced-repetition/*',
            stats: '/api/stats/*'
        }
    });
});

// API usage stats endpoint
app.get('/api/usage-stats', authenticateToken, (req, res) => {
    const sessionStats = req.userId ? tokenUsage.sessions.get(req.userId) : null;
    
    // Calculate total cached tokens across all sessions
    let totalCachedTokens = 0;
    for (const session of tokenUsage.sessions.values()) {
        totalCachedTokens += session.cachedTokens || 0;
    }
    
    res.json({
        total: {
            tokens: tokenUsage.totalTokens,
            cost: tokenUsage.totalCost.toFixed(4),
            cachedTokens: totalCachedTokens,
            averageTokensPerRequest: tokenUsage.totalTokens ? 
                Math.round(tokenUsage.totalTokens / (tokenUsage.sessions.size || 1)) : 0
        },
        session: sessionStats || { tokens: 0, cost: 0, cachedTokens: 0 },
        pricing: PRICING['gpt-4o-mini'],
        optimization: {
            cachedTokensSavings: `$${((totalCachedTokens / 1000000) * (PRICING['gpt-4o-mini'].input - PRICING['gpt-4o-mini'].cached_input)).toFixed(4)} saved from cached tokens`,
            note: 'OpenAI automatically caches prompts >1024 tokens for 50% discount'
        },
        timestamp: new Date().toISOString()
    });
});

// Enhanced health check endpoint with testing integration
app.get('/health', backendTesting.healthCheck());

// Test connection endpoint
app.get('/test-connection', (req, res) => {
    res.json({
        message: 'Backend connection successful!',
        timestamp: new Date().toISOString(),
        origin: req.get('Origin'),
        userAgent: req.get('User-Agent')
    });
});

// API version of test connection endpoint for collaborative testing
app.get('/api/test-connection', (req, res) => {
    res.json({
        message: 'API connection successful!',
        timestamp: new Date().toISOString(),
        server: 'StudyMaster AI Backend',
        status: 'operational',
        testing: {
            collaborativeTesterCompatible: true,
            endpoints: ['health', 'test-connection', 'testing-status'],
            backendVersion: '1.0.0'
        },
        origin: req.get('Origin'),
        userAgent: req.get('User-Agent')
    });
});

// Testing status endpoint
app.get('/api/testing-status', backendTesting.getTestingStatus());

app.post('/api/auth/register', async (req, res) => {
    try {
        await initializeDatabase();
        const { email, password, name } = req.body;

        if (!db || !db.collection) {
            return res.status(500).json({ error: 'Database connection failed. Please try again later.' });
        }

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Missing required fields: email, password, name' });
        }

        const existingUser = await db.collection('users').findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = {
            email,
            password: hashedPassword,
            name,
            createdAt: new Date(),
            studyStats: {
                totalStudyTime: 0,
                cardsReviewed: 0,
                questionsAnswered: 0,
                streak: 0
            },
            subscription: {
                status: 'free',
                plan: 'free',
                startDate: new Date()
            }
        };

        const result = await db.collection('users').insertOne(user);

        if (!process.env.JWT_SECRET) {
            return res.status(500).json({ error: 'Server configuration error' });
        }

        const token = jwt.sign(
            { userId: result.insertedId, email },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ token, user: { id: result.insertedId, email, name } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        await initializeDatabase();
        const { email, password } = req.body;

        if (!db || !db.collection) {
            return res.status(500).json({ error: 'Database connection failed. Please try again later.' });
        }

        const user = await db.collection('users').findOne({ email });
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!process.env.JWT_SECRET) {
            return res.status(500).json({ error: 'Server configuration error' });
        }

        const token = jwt.sign(
            { userId: user._id, email },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            token,
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                studyStats: user.studyStats
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/upload', authenticateToken, upload.array('files', 20), async (req, res) => {
    try {
        await initializeDatabase();

        const user = req.userId === 'demo'
            ? { subscription: { status: 'free' } }
            : await db.collection('users').findOne({ _id: new ObjectId(req.userId) });

        // Ensure user exists and has subscription info
        const userWithDefaults = user || { subscription: { status: 'free' } };
        if (!userWithDefaults.subscription) {
            userWithDefaults.subscription = { status: 'free' };
        }

        const isProUser = userWithDefaults.subscription && userWithDefaults.subscription.status === 'active';

        if (!isProUser) {
            const existingFiles = req.userId === 'demo' ? 0 : await db.collection('files').countDocuments({ userId: req.userId });
            const newFileCount = req.files.length;

            if (existingFiles + newFileCount > 15) {
                return res.status(400).json({
                    error: 'Free tier limited to 15 files. Upgrade to Pro for unlimited uploads.',
                    code: 'UPLOAD_LIMIT_EXCEEDED',
                    currentCount: existingFiles,
                    attemptedCount: newFileCount,
                    maxAllowed: 15
                });
            }
        }

        const processedFiles = [];

        for (const file of req.files) {
            const allowedExtensions = ['.pdf', '.txt', '.doc', '.docx', '.md'];
            const fileExtension = path.extname(file.originalname).toLowerCase();

            if (!allowedExtensions.includes(fileExtension)) {
                return res.status(400).json({
                    error: `File type ${fileExtension} not allowed. Only PDF, TXT, DOC, DOCX, and MD files are supported.`,
                    code: 'INVALID_FILE_TYPE',
                    fileName: file.originalname
                });
            }

            const text = await extractTextFromFile(file.path, file.mimetype);
            const embedding = await generateEmbedding(text);

            if (req.userId === 'demo') {
                processedFiles.push({
                    id: 'demo-file-' + Date.now(),
                    filename: file.originalname,
                    wordCount: text.split(/\s+/).length,
                    textContent: text
                });
            } else {
                const fileDoc = {
                    userId: req.userId,
                    filename: file.originalname,
                    path: file.path,
                    mimeType: file.mimetype,
                    size: file.size,
                    textContent: text,
                    embedding: embedding,
                    uploadedAt: new Date(),
                    wordCount: text.split(/\s+/).length
                };

                const result = await db.collection('files').insertOne(fileDoc);

                processedFiles.push({
                    id: result.insertedId,
                    filename: file.originalname,
                    wordCount: fileDoc.wordCount
                });
            }
        }

        res.json({
            success: true,
            files: processedFiles,
            totalWords: processedFiles.reduce((sum, f) => sum + f.wordCount, 0)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get user files endpoint
app.get('/api/files', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();
        
        if (req.userId === 'demo') {
            // Return demo files or empty for demo users
            res.json({ files: [] });
            return;
        }
        
        const files = await db.collection('files').find({ userId: req.userId })
            .sort({ uploadedAt: -1 })
            .project({ filename: 1, _id: 1, uploadedAt: 1, wordCount: 1 })
            .toArray();
            
        // Convert _id to id for frontend compatibility
        const formattedFiles = files.map(file => ({
            id: file._id.toString(),
            filename: file.filename,
            uploadedAt: file.uploadedAt,
            wordCount: file.wordCount
        }));
            
        res.json({ files: formattedFiles });
    } catch (error) {
        console.error('❌ Error fetching files:', error);
        res.status(500).json({ error: 'Failed to fetch files' });
    }
});

// Create study session for Keep Going feature
app.post('/api/sessions', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();
        const { fileIds, topic } = req.body;
        
        // Get file content
        const files = await db.collection('files').find({
            _id: { $in: fileIds.map(id => new ObjectId(id)) },
            userId: req.userId
        }).toArray();
        
        if (!files.length) {
            return res.status(404).json({ error: 'Files not found' });
        }
        
        const combinedText = files.map(f => f.textContent).join('\n\n');
        
        // Create context summary (keep it short for speed)
        const contextSummary = combinedText.substring(0, 800);
        const topicKey = topic || `study_${Date.now()}`;
        
        // Create session
        const session = {
            userId: req.userId,
            topicKey,
            sourceFileIds: fileIds,
            contextSummary,
            currentBatch: 1,
            totalGenerated: 0,
            previousTopics: [],
            createdAt: new Date(),
            updatedAt: new Date()
        };
        
        const result = await db.collection('study_sessions').insertOne(session);
        const sessionId = result.insertedId.toString();
        
        // Generate first batch of 20 questions
        console.log('🚀 Generating initial batch of 20 questions for session...');
        const questions = await generateQuestionBatch(combinedText, { contextSummary });
        
        // Store questions with status tracking
        const batch = {
            sessionId: new ObjectId(sessionId),
            batchNumber: 1,
            questions: questions.map((q, idx) => ({
                _id: new ObjectId(),
                ...q,
                status: 'unseen',
                index: idx
            })),
            createdAt: new Date()
        };
        
        await db.collection('question_batches').insertOne(batch);
        
        // Update session
        await db.collection('study_sessions').updateOne(
            { _id: new ObjectId(sessionId) },
            { 
                $set: { totalGenerated: 20 },
                $push: { previousTopics: { $each: questions.slice(0, 5).map(q => q.question.substring(0, 30)) } }
            }
        );
        
        // Cache session for fast access
        questionSessionCache.set(sessionId, {
            contextSummary,
            topicKey,
            questions: batch.questions
        });
        
        res.json({ 
            sessionId,
            initialQuestions: batch.questions.slice(0, 5) // Return first 5 questions
        });
        
    } catch (error) {
        console.error('❌ Error creating session:', error);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// Get next questions from session (Keep Going functionality)
app.get('/api/sessions/:id/next', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();
        const { id } = req.params;
        const limit = parseInt(req.query.limit) || 5;
        
        // Try cache first
        const cached = questionSessionCache.get(id);
        if (cached) {
            const unseenQuestions = cached.questions.filter(q => q.status === 'unseen').slice(0, limit);
            if (unseenQuestions.length > 0) {
                // Mark as shown
                unseenQuestions.forEach(q => q.status = 'shown');
                return res.json({ 
                    questions: unseenQuestions,
                    remaining: cached.questions.filter(q => q.status === 'unseen').length - unseenQuestions.length
                });
            }
        }
        
        // Get from database
        const batch = await db.collection('question_batches').findOne({
            sessionId: new ObjectId(id),
            'questions.status': 'unseen'
        });
        
        if (!batch || !batch.questions) {
            // Need to generate more questions
            const session = await db.collection('study_sessions').findOne({ _id: new ObjectId(id) });
            
            if (!session) {
                return res.status(404).json({ error: 'Session not found' });
            }
            
            // Generate next batch
            console.log('🔄 Generating next batch of 20 questions...');
            const files = await db.collection('files').find({
                _id: { $in: session.sourceFileIds.map(fid => new ObjectId(fid)) }
            }).toArray();
            
            const combinedText = files.map(f => f.textContent).join('\n\n');
            const questions = await generateQuestionBatch(combinedText, {
                contextSummary: session.contextSummary,
                previousTopics: session.previousTopics
            });
            
            // Store new batch
            const newBatch = {
                sessionId: new ObjectId(id),
                batchNumber: session.currentBatch + 1,
                questions: questions.map((q, idx) => ({
                    _id: new ObjectId(),
                    ...q,
                    status: 'unseen',
                    index: idx + session.totalGenerated
                })),
                createdAt: new Date()
            };
            
            await db.collection('question_batches').insertOne(newBatch);
            
            // Update session
            await db.collection('study_sessions').updateOne(
                { _id: new ObjectId(id) },
                { 
                    $set: { 
                        currentBatch: session.currentBatch + 1,
                        totalGenerated: session.totalGenerated + 20,
                        updatedAt: new Date()
                    },
                    $push: { 
                        previousTopics: { 
                            $each: questions.slice(0, 5).map(q => q.question.substring(0, 30)) 
                        }
                    }
                }
            );
            
            // Update cache
            questionSessionCache.set(id, {
                contextSummary: session.contextSummary,
                topicKey: session.topicKey,
                questions: newBatch.questions
            });
            
            const returnQuestions = newBatch.questions.slice(0, limit);
            returnQuestions.forEach(q => q.status = 'shown');
            
            return res.json({ 
                questions: returnQuestions,
                remaining: 20 - limit,
                newBatchGenerated: true
            });
        }
        
        // Get unseen questions
        const unseenQuestions = batch.questions
            .filter(q => q.status === 'unseen')
            .slice(0, limit);
        
        if (unseenQuestions.length > 0) {
            // Mark as shown in database
            const questionIds = unseenQuestions.map(q => q._id);
            await db.collection('question_batches').updateOne(
                { _id: batch._id },
                { 
                    $set: {
                        'questions.$[elem].status': 'shown',
                        'questions.$[elem].seenAt': new Date()
                    }
                },
                {
                    arrayFilters: [{ 'elem._id': { $in: questionIds } }]
                }
            );
            
            res.json({ 
                questions: unseenQuestions,
                remaining: batch.questions.filter(q => q.status === 'unseen').length - unseenQuestions.length
            });
        } else {
            res.json({ 
                questions: [],
                remaining: 0,
                needsNewBatch: true
            });
        }
        
    } catch (error) {
        console.error('❌ Error getting next questions:', error);
        res.status(500).json({ error: 'Failed to get questions' });
    }
});

app.post('/api/generate', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();
        const { fileIds, mode } = req.body;

        console.log(`🔍 Starting content generation for mode: ${mode}, fileIds: ${fileIds}`);

        if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
            console.error('❌ Invalid or missing fileIds in request body');
            return res.status(400).json({ error: 'fileIds array is required and must not be empty' });
        }

        let files = [];

        if (req.userId === 'demo') {
            // For demo mode, create mock file data
            files = [{
                _id: 'demo-file',
                filename: 'demo-content.txt',
                textContent: `Artificial Intelligence Overview

AI is a branch of computer science that aims to create intelligent machines. Key concepts include:

1. Machine Learning: Systems that learn from data
2. Neural Networks: Computing systems inspired by biological neural networks
3. Deep Learning: ML using deep neural networks
4. Natural Language Processing: AI that understands human language
5. Computer Vision: AI that interprets visual information

Applications:
- Autonomous vehicles
- Medical diagnosis
- Financial trading
- Virtual assistants
- Recommendation systems

Ethical considerations include bias, privacy, job displacement, and AI safety.`,
                userId: 'demo',
                uploadedAt: new Date(),
                wordCount: 87
            }];
        } else {
            // Convert fileIds to ObjectIds, filtering out invalid ones
            const validObjectIds = fileIds
                .filter(id => id && id !== 'demo' && ObjectId.isValid(id))
                .map(id => new ObjectId(id));

            if (validObjectIds.length > 0) {
                files = await db.collection('files').find({
                    _id: { $in: validObjectIds },
                    userId: req.userId
                }).toArray();
            }
        }

        console.log(`📁 Found ${files.length} files for processing`);

        if (files.length === 0) {
            console.error('❌ No files found for the provided file IDs');
            return res.status(400).json({ error: 'No files found for processing' });
        }

        const combinedText = files.map(f => f.textContent).join('\n\n');
        console.log(`📝 Combined text length: ${combinedText.length} characters`);

        if (combinedText.length === 0) {
            console.error('❌ No text content found in files');
            return res.status(400).json({ error: 'No text content found in uploaded files' });
        }

        // Request coalescing - prevent duplicate processing
        const requestKey = generateRequestKey(req.userId, fileIds, mode, combinedText.length);
        
        // Check if identical request is already in flight
        if (inflightRequests.has(requestKey)) {
            console.log('🔄 Coalescing duplicate request, waiting for existing generation...');
            const result = await inflightRequests.get(requestKey);
            return res.json(result);
        }
        
        // Check cache for recent identical requests (5 minute TTL)
        const cachedResult = contentCache.get(requestKey);
        if (cachedResult && Date.now() - cachedResult.timestamp < 300000) {
            console.log('✅ Returning cached result for identical request');
            return res.json(cachedResult.data);
        }

        let content = {};
        const generationPromise = (async () => {
            try {
                console.log(`🔄 Starting optimized parallel content generation for mode: ${mode}...`);
                const startTime = Date.now();
                
                // Define content generation tasks based on mode
                const tasks = [];
                
                if (mode === 'comprehensive') {
                    // Optimize comprehensive mode to run all generation in parallel
                    console.log('🚀 Starting parallel comprehensive generation...');
                    
                    // Run ALL content generation in parallel for maximum speed
                    const comprehensiveTasks = [
                        ['summary', generateStudyContent(combinedText, 'summary', { sessionId: req.userId })],
                        ['studyPlan', generateStudyContent(combinedText, 'studyPlan', { days: 7, sessionId: req.userId })],
                        ['questions', generateStudyContent(combinedText, 'questions', { sessionId: req.userId })],
                        ['flashcards', generateStudyContent(combinedText, 'flashcards', { sessionId: req.userId })]
                    ];
                    
                    console.log('⚡ Generating all content types in parallel (4 tasks)...');
                    const comprehensiveResults = await Promise.allSettled(comprehensiveTasks.map(([key, promise]) => 
                        promise.then(result => ({ key, result }))
                    ));
                    
                    // Process all results
                    for (const result of comprehensiveResults) {
                        if (result.status === 'fulfilled') {
                            const { key, result: data } = result.value;
                            content[key] = data;
                            console.log(`✅ ${key} generated successfully`);
                        } else {
                            console.error(`❌ Failed to generate ${result.reason?.message || 'unknown content'}`);
                        }
                    }
                    
                    console.log('🎯 Parallel comprehensive generation completed');
                    
                } else {
                    // Individual modes with parallel execution where possible
                    if (mode === 'summary') {
                        tasks.push(['summary', generateStudyContent(combinedText, 'summary', { sessionId: req.userId })]);
                    }
                    if (mode === 'practice' || mode === 'questions') {
                        tasks.push(['questions', generateStudyContent(combinedText, 'questions', { sessionId: req.userId })]);
                    }
                    if (mode === 'flashcards') {
                        tasks.push(['flashcards', generateStudyContent(combinedText, 'flashcards', { sessionId: req.userId })]);
                    }
                    if (mode === 'gaps') {
                        tasks.push(['knowledgeGaps', generateStudyContent(combinedText, 'knowledgeGaps', { sessionId: req.userId })]);
                    }
                    // Only generate study plan if no specific mode requested or if summary mode
                    if (mode === 'summary') {
                        tasks.push(['studyPlan', generateStudyContent(combinedText, 'studyPlan', { days: 7, sessionId: req.userId })]);
                    }
                    
                    // Execute all tasks in parallel using Promise.allSettled for better error handling
                    console.log(`⚡ Executing ${tasks.length} content generation tasks in parallel...`);
                    const results = await Promise.allSettled(tasks.map(([key, promise]) => 
                        promise.then(result => ({ key, result }))
                    ));
                    
                    // Process results and handle any failures gracefully
                    for (const result of results) {
                        if (result.status === 'fulfilled') {
                            const { key, result: data } = result.value;
                            content[key] = data;
                            console.log(`✅ ${key} generated successfully`);
                        } else {
                            console.error(`❌ Failed to generate content:`, result.reason.message);
                            // Continue with partial results rather than failing completely
                        }
                    }
                }
                
                const endTime = Date.now();
                console.log(`⚡ Parallel content generation completed in ${endTime - startTime}ms`);

            if (content.flashcards && content.flashcards.flashcards) {
                content.flashcards = content.flashcards.flashcards;
            }

            if (content.studyPlan && content.studyPlan.studyPlan) {
                if (typeof content.studyPlan.studyPlan === 'object' && !Array.isArray(content.studyPlan.studyPlan)) {
                    content.studyPlan = Object.values(content.studyPlan.studyPlan);
                } else if (Array.isArray(content.studyPlan.studyPlan)) {
                    content.studyPlan = content.studyPlan.studyPlan;
                }
            }

                const session = {
                    userId: req.userId,
                    fileIds,
                    content,
                    mode,
                    createdAt: new Date()
                };

                console.log('💾 Saving study session to database...');
                const dbResult = await db.collection('studySessions').insertOne(session);
                console.log('✅ Study session saved successfully');

                const responseData = {
                    sessionId: dbResult.insertedId,
                    content: content
                };
                
                // Cache the result for future identical requests
                contentCache.set(requestKey, {
                    data: responseData,
                    timestamp: Date.now()
                });
                
                return responseData;
            } catch (error) {
                console.error('❌ Content generation failed:', error);
                throw error;
            }
        })();
        
        // Store promise in inflight requests to enable coalescing
        inflightRequests.set(requestKey, generationPromise);
        
        try {
            const result = await generationPromise;
            res.json(result);
        } finally {
            // Clean up inflight request
            inflightRequests.delete(requestKey);
        }
    } catch (error) {
        console.error('❌ Generate endpoint error:', error);
        res.status(500).json({
            error: `Content generation failed: ${error.message}`,
            details: error.stack
        });
    }
});

// Generate more flashcards endpoint
app.post('/api/generate-more-flashcards', authenticateToken, async (req, res) => {
    try {
        const { fileIds, existingTerms = [] } = req.body;

        if (!fileIds || fileIds.length === 0) {
            return res.status(400).json({ error: 'File IDs are required' });
        }

        console.log(`📚 Generating additional flashcards for ${fileIds.length} files...`);
        console.log(`🔄 Avoiding ${existingTerms.length} existing terms`);

        // Get file contents
        const files = req.userId === 'demo' ? [{
            content: `This is a placeholder for demo mode. The actual content would come from user files.`
        }] : await db.collection('files').find({
            _id: { $in: fileIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id)) },
            userId: req.userId
        }).toArray();

        if (files.length === 0) {
            return res.status(404).json({ error: 'No files found' });
        }

        const allContent = files.map(file => file.textContent || file.content).join('\n\n'); // Handle cases where content might be stored differently
        const contentChunks = allContent.split('\n\n').filter(chunk => chunk.trim().length > 50);

        if (contentChunks.length === 0) {
            return res.status(400).json({ error: 'No substantial content found in files' });
        }

        // Generate 6 more flashcards
        const MORE_BATCH_SIZE = 6;
        const usedTermsList = existingTerms.join(', ');
        const topic = contentChunks[Math.floor(Math.random() * contentChunks.length)]; // Random chunk for variety

        const prompt = `Create EXACTLY ${MORE_BATCH_SIZE} premium flashcards with enhanced features from this content:

${topic}

${existingTerms.length > 0 ? `AVOID these already used terms: ${usedTermsList}` : ''}

Focus on intermediate to advanced concepts that build upon basic knowledge.

Each flashcard must have ALL these elements:
- term: Unique concept name (not in existing terms)
- definition: Clear explanation with context
- visualDescription: Mental imagery for memory
- mnemonic: Memory device or acronym
- multipleExamples: Array of exactly 3 real-world examples
- commonMisconceptions: Array of exactly 3 common mistakes
- connections: Array of exactly 3 related concepts
- practiceQuestion: Self-test question
- memoryTips: Study strategies
- category: Subject area
- difficulty: 1-5 scale
- importance: 1-5 scale

Return ONLY this JSON structure:
{
    "flashcards": [
        {
            "term": "Unique Concept Name",
            "definition": "Clear definition with context",
            "visualDescription": "Mental imagery description",
            "mnemonic": "Memory device",
            "multipleExamples": ["Example 1", "Example 2", "Example 3"],
            "commonMisconceptions": ["Mistake 1", "Mistake 2", "Mistake 3"],
            "connections": ["Related concept 1", "Related concept 2", "Related concept 3"],
            "practiceQuestion": "Test question",
            "memoryTips": "Study strategies",
            "category": "Subject",
            "difficulty": 3,
            "importance": 4
        }
    ]
}`;

        const result = await makeValidatedAPICall(prompt, flashcardBatchSchema, validateFlashcardBatch, 'batch_flashcards', 'additional', req.userId);

        console.log(`✅ Generated ${result.flashcards.length} additional flashcards`);
        res.json({ success: true, flashcards: result.flashcards });

    } catch (error) {
        console.error('❌ Additional flashcards generation failed:', error);
        res.status(500).json({
            error: 'Failed to generate additional flashcards',
            details: error.message
        });
    }
});

// Chat endpoint
app.post('/api/chat', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();
        const { message, sessionId } = req.body;

        let session = null;

        if (req.userId === 'demo') {
            // Demo mode - create mock session with template content
            session = {
                _id: 'demo-session',
                userId: 'demo',
                fileIds: ['demo-file'],
                content: {
                    summary: { overview: "Demo AI content session covering machine learning fundamentals" },
                    flashcards: [
                        {
                            _id: 'demo-card-1',
                            term: 'Machine Learning',
                            definition: 'A subset of AI that enables systems to automatically learn and improve from experience without being explicitly programmed',
                            visualDescription: 'Imagine a student who learns to recognize patterns by studying many examples',
                            mnemonic: 'ML = Making Learning automatic',
                            multipleExamples: ['Image recognition systems', 'Recommendation algorithms', 'Spam email detection'],
                            commonMisconceptions: ['ML is not just automation', 'It requires large amounts of data', 'Not all AI is machine learning'],
                            connections: ['Connects to neural networks', 'Foundation for deep learning', 'Used in data science'],
                            practiceQuestion: 'How does supervised learning differ from unsupervised learning?',
                            memoryTips: 'Think of ML as teaching computers to learn like humans do - through examples and practice',
                            category: 'AI Fundamentals',
                            difficulty: 3,
                            importance: 5
                        },
                        {
                            _id: 'demo-card-2',
                            term: 'Neural Network',
                            definition: 'A computing system inspired by biological neural networks that uses interconnected nodes to process information',
                            visualDescription: 'Like a web of connected brain cells, each node processes and passes information',
                            mnemonic: 'Neural = Network of artificial neurons',
                            multipleExamples: ['Image classification networks', 'Language processing models', 'Voice recognition systems'],
                            commonMisconceptions: ['Not exactly like human brains', 'Requires training to function', 'More nodes doesn\'t always mean better'],
                            connections: ['Foundation of deep learning', 'Uses machine learning principles', 'Inspired by neuroscience'],
                            practiceQuestion: 'What role do weights and biases play in neural networks?',
                            memoryTips: 'Picture neurons in your brain - that\'s the inspiration for artificial neural networks',
                            category: 'AI Fundamentals',
                            difficulty: 4,
                            importance: 4
                        },
                        {
                            _id: 'demo-card-3',
                            term: 'Deep Learning',
                            definition: 'A subset of machine learning that uses neural networks with multiple layers to model complex patterns in data',
                            visualDescription: 'Like a multi-story building where each floor processes different aspects of information',
                            mnemonic: 'Deep = Multiple layers Deep down',
                            multipleExamples: ['Computer vision systems', 'Natural language processing', 'Autonomous vehicle perception'],
                            commonMisconceptions: ['Not always better than simple ML', 'Requires significant computational power', 'Black box nature can be problematic'],
                            connections: ['Advanced form of neural networks', 'Powers modern AI applications', 'Requires machine learning foundations'],
                            practiceQuestion: 'Why are multiple layers important in deep learning architectures?',
                            memoryTips: 'The \'deep\' refers to many layers, like diving deep into an ocean of data',
                            category: 'Advanced AI',
                            difficulty: 4,
                            importance: 5
                        },
                        {
                            _id: 'demo-card-4',
                            term: 'Natural Language Processing',
                            definition: 'A field of AI focused on enabling computers to understand, interpret, and generate human language',
                            visualDescription: 'Like a universal translator that understands the meaning behind words and sentences',
                            mnemonic: 'NLP = Natural Language Processing for computers',
                            multipleExamples: ['Chatbots and virtual assistants', 'Language translation services', 'Sentiment analysis tools'],
                            commonMisconceptions: ['Not just keyword matching', 'Context matters significantly', 'Cultural nuances are challenging'],
                            connections: ['Uses machine learning techniques', 'Often employs neural networks', 'Combines linguistics with AI'],
                            practiceQuestion: 'How does tokenization help in natural language processing?',
                            memoryTips: 'Think of NLP as teaching computers to \'speak human\' naturally',
                            category: 'AI Applications',
                            difficulty: 3,
                            importance: 4
                        },
                        {
                            _id: 'demo-card-5',
                            term: 'Computer Vision',
                            definition: 'A field of AI that enables computers to interpret and understand visual information from the world',
                            visualDescription: 'Like giving computers eyes and the brain power to understand what they see',
                            mnemonic: 'CV = Computer Vision for seeing and understanding',
                            multipleExamples: ['Medical image analysis', 'Facial recognition systems', 'Object detection in autonomous vehicles'],
                            commonMisconceptions: ['Not just image filtering', 'Requires understanding context', 'Lighting and angles affect performance'],
                            connections: ['Heavily uses deep learning', 'Applications in robotics', 'Combines with sensor technology'],
                            practiceQuestion: 'What are the main challenges in computer vision compared to human vision?',
                            memoryTips: 'Computer Vision is like teaching a computer to \'see\' and understand images like humans do',
                            category: 'AI Applications',
                            difficulty: 4,
                            importance: 4
                        }
                    ],
                    questions: {
                        allQuestions: [
                            {
                                question: "What is the primary characteristic that defines machine learning?",
                                options: ["Learning from data without explicit programming", "Using only rule-based systems", "Requiring manual updates for new scenarios", "Operating without any training data"],
                                correctAnswer: "Learning from data without explicit programming",
                                explanation: "Machine learning's key feature is its ability to learn and improve from data automatically, without being explicitly programmed for every scenario.",
                                difficulty: 2,
                                topic: "Machine Learning Fundamentals",
                                type: "direct",
                                learningObjective: "Understand the core definition of machine learning",
                                hints: ["Think about what makes ML different from traditional programming"],
                                commonMistakes: ["Confusing ML with simple automation"],
                                timeEstimate: "2 minutes"
                            },
                            {
                                question: "In a neural network, what role do weights play?",
                                options: ["They determine the strength of connections between neurons", "They count the number of layers", "They store the training data", "They determine the network architecture"],
                                correctAnswer: "They determine the strength of connections between neurons",
                                explanation: "Weights in neural networks control how much influence one neuron has on another, essentially determining the strength of connections.",
                                difficulty: 3,
                                topic: "Neural Networks",
                                type: "direct",
                                learningObjective: "Understand the function of weights in neural networks",
                                hints: ["Consider how neurons communicate with each other"],
                                commonMistakes: ["Thinking weights are just storage for data"],
                                timeEstimate: "2 minutes"
                            },
                            {
                                question: "What distinguishes deep learning from traditional machine learning?",
                                options: ["Multiple layers of neural networks", "Faster processing speed", "Less data requirements", "Simpler algorithms"],
                                correctAnswer: "Multiple layers of neural networks",
                                explanation: "Deep learning uses neural networks with multiple hidden layers (\"deep\" architecture) to learn complex patterns, unlike traditional ML which often uses simpler, single-layer approaches.",
                                difficulty: 3,
                                topic: "Deep Learning",
                                type: "direct",
                                learningObjective: "Differentiate deep learning from traditional ML approaches",
                                hints: ["The word 'deep' refers to the architecture"],
                                commonMistakes: ["Thinking deep learning is always better than traditional ML"],
                                timeEstimate: "2 minutes"
                            }
                        ]
                    }
                },
                mode: 'comprehensive',
                createdAt: new Date()
            };
        } else if (sessionId && ObjectId.isValid(sessionId)) {
            session = await db.collection('studySessions').findOne({
                _id: new ObjectId(sessionId),
                userId: req.userId
            });

            if (!session) {
                return res.status(404).json({ error: 'Session not found' });
            }
        } else {
            // Create a default session for the user
            session = {
                _id: 'default-session',
                userId: req.userId,
                fileIds: [],
                content: {},
                mode: 'chat',
                createdAt: new Date()
            };
        }

        // Get conversation history for context
        const conversationHistory = req.userId === 'demo' ? [] : await db.collection('chatHistory').find({
            sessionId: sessionId,
            userId: req.userId
        }).sort({ timestamp: -1 }).limit(10).toArray();

        const files = req.userId === 'demo' || !session ? [] : await db.collection('files').find({
            _id: { $in: session.fileIds.filter(id => id && id !== 'demo').map(id => new ObjectId(id)) }
        }).toArray();

        const context = files.map(f => f.textContent).join('\n\n').substring(0, 4000);

        // Build conversation context
        const recentHistory = conversationHistory.reverse().slice(0, 5);
        const historyContext = recentHistory.map(h => `${h.role}: ${h.message}`).join('\n');

        // Enhanced Socratic tutoring prompt (inspired by Khanmigo)
        const tutorPrompt = `You are an expert AI tutor using the Socratic method to help students learn. Your role is to GUIDE students to discover answers through thoughtful questioning rather than giving direct answers.

CORE PRINCIPLES:
1. Ask leading questions that help students think through problems
2. Encourage critical thinking and self-discovery
3. Break complex concepts into smaller, manageable steps
4. Provide hints and scaffolding, not direct answers
5. Celebrate progress and build confidence
6. Adapt to the student's learning level and pace

CONVERSATION CONTEXT:
Study Material: ${context ? context.substring(0, 2000) : 'General academic content'}

RECENT CONVERSATION:
${historyContext}

STUDENT'S CURRENT MESSAGE: ${message}

RESPONSE GUIDELINES:
- If student asks a direct question, respond with guiding questions instead
- Use phrases like "What do you think about...", "How might you approach...", "What patterns do you notice..."
- If student seems stuck, provide a small hint and ask a follow-up question
- If student answers correctly, praise them and ask deeper questions to extend learning
- Keep responses conversational, encouraging, and educational
- Limit responses to 2-3 sentences to maintain engagement

Respond as an encouraging tutor who helps students discover knowledge through questioning:`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: tutorPrompt
                },
                {
                    role: "user",
                    content: message
                }
            ],
            temperature: 0.7,
            max_tokens: 500
        });

        const aiResponse = response.choices[0].message.content;

        await db.collection('chatHistory').insertOne({
            userId: req.userId,
            sessionId,
            message,
            response: aiResponse,
            timestamp: new Date()
        });

        res.json({ response: aiResponse });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/spaced-repetition/review', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();
        const { cardId, quality } = req.body;

        let card = null;

        if (req.userId === 'demo') {
            // Demo mode - simulate template format card data
            card = {
                _id: 'demo-card',
                term: 'Machine Learning',
                definition: 'A subset of AI that enables systems to automatically learn and improve from experience without being explicitly programmed',
                visualDescription: 'Imagine a student who learns to recognize patterns by studying many examples',
                mnemonic: 'ML = Making Learning automatic',
                multipleExamples: ['Image recognition systems', 'Recommendation algorithms', 'Spam email detection'],
                commonMisconceptions: ['ML is not just automation', 'It requires large amounts of data', 'Not all AI is machine learning'],
                connections: ['Connects to neural networks', 'Foundation for deep learning', 'Used in data science'],
                practiceQuestion: 'How does supervised learning differ from unsupervised learning?',
                memoryTips: 'Think of ML as teaching computers to learn like humans do - through examples and practice',
                category: 'AI Fundamentals',
                difficulty: 3,
                importance: 5,
                repetitions: 0,
                easeFactor: 2.5,
                interval: 1,
                nextReview: new Date(),
                lastReview: null
            };
        } else if (cardId && ObjectId.isValid(cardId)) {
            card = await db.collection('flashcards').findOne({
                _id: new ObjectId(cardId),
                userId: req.userId
            });
        }

        if (!card && req.userId !== 'demo') {
            return res.status(404).json({ error: 'Card not found' });
        }

        if (req.userId !== 'demo') {
            const { repetitions, interval, easeFactor, nextReview } = calculateSpacedRepetition(
                quality,
                card.repetitions || 0,
                card.easeFactor || 2.5,
                card.interval || 1
            );

            await db.collection('flashcards').updateOne(
                { _id: cardId && cardId !== 'demo' ? new ObjectId(cardId) : null },
                {
                    $set: {
                        repetitions,
                        interval,
                        easeFactor,
                        nextReview,
                        lastReview: new Date()
                    }
                }
            );

            if (req.userId !== 'demo') {
                await db.collection('users').updateOne(
                    { _id: new ObjectId(req.userId) },
                    {
                        $inc: {
                            'studyStats.cardsReviewed': 1
                        }
                    }
                );
            }
        }

        res.json({ nextReview, interval });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/spaced-repetition/due/:userId', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();
        let dueCards = [];

        if (req.userId === 'demo') {
            // Demo mode - return 5 sample cards for template format
            dueCards = [
                {
                    _id: 'demo-card-1',
                    term: 'Machine Learning',
                    definition: 'A subset of AI that enables systems to automatically learn and improve from experience without being explicitly programmed',
                    visualDescription: 'Imagine a student who learns to recognize patterns by studying many examples',
                    mnemonic: 'ML = Making Learning automatic',
                    multipleExamples: ['Image recognition systems', 'Recommendation algorithms', 'Spam email detection'],
                    commonMisconceptions: ['ML is not just automation', 'It requires large amounts of data', 'Not all AI is machine learning'],
                    connections: ['Connects to neural networks', 'Foundation for deep learning', 'Used in data science'],
                    practiceQuestion: 'How does supervised learning differ from unsupervised learning?',
                    memoryTips: 'Think of ML as teaching computers to learn like humans do - through examples and practice',
                    category: 'AI Fundamentals',
                    difficulty: 3,
                    importance: 5
                },
                {
                    _id: 'demo-card-2',
                    term: 'Neural Network',
                    definition: 'A computing system inspired by biological neural networks that uses interconnected nodes to process information',
                    visualDescription: 'Like a web of connected brain cells, each node processes and passes information',
                    mnemonic: 'Neural = Network of artificial neurons',
                    multipleExamples: ['Image classification networks', 'Language processing models', 'Voice recognition systems'],
                    commonMisconceptions: ['Not exactly like human brains', 'Requires training to function', 'More nodes doesn\'t always mean better'],
                    connections: ['Foundation of deep learning', 'Uses machine learning principles', 'Inspired by neuroscience'],
                    practiceQuestion: 'What role do weights and biases play in neural networks?',
                    memoryTips: 'Picture neurons in your brain - that\'s the inspiration for artificial neural networks',
                    category: 'AI Fundamentals',
                    difficulty: 4,
                    importance: 4
                },
                {
                    _id: 'demo-card-3',
                    term: 'Deep Learning',
                    definition: 'A subset of machine learning that uses neural networks with multiple layers to model complex patterns in data',
                    visualDescription: 'Like a multi-story building where each floor processes different aspects of information',
                    mnemonic: 'Deep = Multiple layers Deep down',
                    multipleExamples: ['Computer vision systems', 'Natural language processing', 'Autonomous vehicle perception'],
                    commonMisconceptions: ['Not always better than simple ML', 'Requires significant computational power', 'Black box nature can be problematic'],
                    connections: ['Advanced form of neural networks', 'Powers modern AI applications', 'Requires machine learning foundations'],
                    practiceQuestion: 'Why are multiple layers important in deep learning architectures?',
                    memoryTips: 'The \'deep\' refers to many layers, like diving deep into an ocean of data',
                    category: 'Advanced AI',
                    difficulty: 4,
                    importance: 5
                },
                {
                    _id: 'demo-card-4',
                    term: 'Natural Language Processing',
                    definition: 'A field of AI focused on enabling computers to understand, interpret, and generate human language',
                    visualDescription: 'Like a universal translator that understands the meaning behind words and sentences',
                    mnemonic: 'NLP = Natural Language Processing for computers',
                    multipleExamples: ['Chatbots and virtual assistants', 'Language translation services', 'Sentiment analysis tools'],
                    commonMisconceptions: ['Not just keyword matching', 'Context matters significantly', 'Cultural nuances are challenging'],
                    connections: ['Uses machine learning techniques', 'Often employs neural networks', 'Combines linguistics with AI'],
                    practiceQuestion: 'How does tokenization help in natural language processing?',
                    memoryTips: 'Think of NLP as teaching computers to \'speak human\' naturally',
                    category: 'AI Applications',
                    difficulty: 3,
                    importance: 4
                },
                {
                    _id: 'demo-card-5',
                    term: 'Computer Vision',
                    definition: 'A field of AI that enables computers to interpret and understand visual information from the world',
                    visualDescription: 'Like giving computers eyes and the brain power to understand what they see',
                    mnemonic: 'CV = Computer Vision for seeing and understanding',
                    multipleExamples: ['Medical image analysis', 'Facial recognition systems', 'Object detection in autonomous vehicles'],
                    commonMisconceptions: ['Not just image filtering', 'Requires understanding context', 'Lighting and angles affect performance'],
                    connections: ['Heavily uses deep learning', 'Applications in robotics', 'Combines with sensor technology'],
                    practiceQuestion: 'What are the main challenges in computer vision compared to human vision?',
                    memoryTips: 'Computer Vision is like teaching a computer to \'see\' and understand images like humans do',
                    category: 'AI Applications',
                    difficulty: 4,
                    importance: 4
                }
            ];
        } else if (ObjectId.isValid(req.userId)) {
            dueCards = await db.collection('flashcards').find({
                userId: req.userId,
                nextReview: { $lte: new Date() }
            }).limit(20).toArray();
        }

        res.json({ cards: dueCards });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/stats/:userId', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();

        // Handle demo user with sample data
        if (req.userId === 'demo') {
            return res.json({
                totalStudyTime: 120,
                cardsReviewed: 19,
                questionsAnswered: 45,
                streak: 4,
                weeklyProgress: [],
                accuracy: 85,
                mastery: 72
            });
        }

        // Validate ObjectId format
        if (!ObjectId.isValid(req.userId)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }

        const user = await db.collection('users').findOne({ _id: new ObjectId(req.userId) });

        // Return default stats if user not found
        if (!user) {
            return res.json({
                totalStudyTime: 0,
                cardsReviewed: 0,
                questionsAnswered: 0,
                streak: 0,
                weeklyProgress: [],
                accuracy: 0,
                mastery: 0
            });
        }

        // Ensure user has studyStats with defaults
        const studyStats = user.studyStats || {
            totalStudyTime: 0,
            cardsReviewed: 0,
            questionsAnswered: 0,
            streak: 0
        };

        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const dailyStats = await db.collection('dailyStats').find({
            userId: req.userId,
            date: { $gte: weekAgo }
        }).toArray().catch(() => []);

        const recentTests = await db.collection('testResults').find({
            userId: req.userId
        }).sort({ date: -1 }).limit(10).toArray().catch(() => []);

        const avgAccuracy = recentTests.length > 0
            ? recentTests.reduce((sum, t) => sum + (t.accuracy || 0), 0) / recentTests.length
            : Math.floor(Math.random() * 30) + 70; // Demo accuracy between 70-100%

        const mastery = Math.round(avgAccuracy * 0.7 + (studyStats.cardsReviewed * 0.3 / Math.max(1, studyStats.cardsReviewed)));

        res.json({
            totalStudyTime: studyStats.totalStudyTime || 0,
            cardsReviewed: studyStats.cardsReviewed || 0,
            questionsAnswered: studyStats.questionsAnswered || 0,
            streak: studyStats.streak || 0,
            weeklyProgress: dailyStats || [],
            accuracy: Math.round(avgAccuracy) || 0,
            mastery: Math.min(100, mastery) || 0
        });
    } catch (error) {
        console.error('Stats API error:', error);
        // Return sample data on error to prevent UI breaks
        res.json({
            totalStudyTime: 5,
            cardsReviewed: 12,
            questionsAnswered: 25,
            streak: 2,
            weeklyProgress: [],
            accuracy: 78,
            mastery: 65
        });
    }
});

app.post('/api/stats/update-time', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();
        const { minutes } = req.body;

        if (req.userId !== 'demo') {
            await db.collection('users').updateOne(
                { _id: new ObjectId(req.userId) },
                {
                    $inc: {
                        'studyStats.totalStudyTime': minutes
                    }
                }
            );
        }

        const today = new Date().toISOString().split('T')[0];
        if (req.userId !== 'demo') {
            await db.collection('dailyStats').updateOne(
                { userId: req.userId, date: today },
                {
                    $inc: { studyMinutes: minutes },
                    $setOnInsert: { date: today, userId: req.userId }
                },
                { upsert: true }
            );
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/create-checkout-session', authenticateToken, async (req, res) => {
    try {
        const { priceId } = req.body;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price: priceId,
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:8080'}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:8080'}`,
            client_reference_id: req.userId,
            metadata: {
                userId: req.userId
            }
        });

        res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
        console.error('Stripe checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

app.post('/webhook/stripe', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        await initializeDatabase();

        switch (event.type) {
            case 'checkout.session.completed':
                const session = event.data.object;
                if (session.metadata.userId && session.metadata.userId !== 'demo') {
                    await db.collection('users').updateOne(
                        { _id: new ObjectId(session.metadata.userId) },
                        {
                            $set: {
                                subscription: {
                                    status: 'active',
                                    stripeCustomerId: session.customer,
                                    stripeSubscriptionId: session.subscription,
                                    plan: 'pro',
                                    startDate: new Date()
                                }
                            }
                        }
                    );
                }
                break;

            case 'customer.subscription.deleted':
                const subscription = event.data.object;
                await db.collection('users').updateOne(
                    { 'subscription.stripeSubscriptionId': subscription.id },
                    {
                        $set: {
                            'subscription.status': 'cancelled',
                            'subscription.endDate': new Date()
                        }
                    }
                );
                break;
        }

        res.json({received: true});
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// DEPRECATED: Use /api/sessions endpoint instead
// Keeping for backward compatibility but redirecting to sessions
app.post('/api/adaptive-practice', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();
        const { fileIds, weakAreas, difficulty, topic, previousAnswers } = req.body;

        console.log('⚠️ DEPRECATED: /api/adaptive-practice called, redirecting to sessions...');
        console.log('🎯 Generating template-based Keep Going questions (7 direct + 4 twisted)...');

        // Get the user's uploaded content for generating new template questions
        let contentText = 'General study material';

        if (fileIds && fileIds.length > 0 && req.userId !== 'demo') {
            const files = await db.collection('files').find({
                _id: { $in: fileIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id)) },
                userId: req.userId
            }).toArray();

            if (files.length > 0) {
                contentText = files.map(file => file.textContent || file.content).join('\n\n');
            }
        }

        // Generate new 7 direct + 4 twisted questions using template format
        const directPrompt = `Generate 7 NEW practice questions directly from this content, different from previous questions. Focus on areas where the student struggled: ${weakAreas?.join(', ') || 'General review'}.

Content: ${contentText.substring(0, 6000)}

Focus on:
- Key concepts the student got wrong before
- Different aspects of the same topics  
- Reinforcement of fundamental principles
- Alternative ways to test the same knowledge

Return ONLY valid JSON:
{
    "questions": [
        {
            "question": "New question about the content",
            "options": ["Option A", "Option B", "Option C", "Option D"],
            "correctAnswer": "Option A",
            "explanation": "Clear explanation",
            "difficulty": 2,
            "topic": "Topic area",
            "type": "direct",
            "learningObjective": "What this reinforces",
            "hints": ["Helpful hint"],
            "commonMistakes": ["Common mistake"],
            "timeEstimate": "2 minutes"
        }
    ]
}`;

        const twistedPrompt = `Generate 4 NEW "twisted" application questions from this content, focusing on weak areas: ${weakAreas?.join(', ') || 'General review'}.

Content: ${contentText.substring(0, 6000)}

Focus on:
- Real-world applications of concepts the student missed
- Creative scenarios using the same principles
- Cross-connections between different concepts
- Practical problem-solving situations

Return ONLY valid JSON:
{
    "questions": [
        {
            "question": "Creative application question",
            "options": ["Option A", "Option B", "Option C", "Option D"],
            "correctAnswer": "Option A",
            "explanation": "Application explanation",
            "difficulty": 3,
            "topic": "Applied scenario",
            "type": "twisted",
            "learningObjective": "Practical application",
            "hints": ["Application hint"],
            "commonMistakes": ["Application mistake"],
            "timeEstimate": "3 minutes"
        }
    ]
}`;

        // Generate both sets of questions
        const directResult = await makeValidatedAPICall(directPrompt, templateQuestionSchema, validateTemplateQuestions, 'template_questions', 'keep-going-direct', req.userId);
        const twistedResult = await makeValidatedAPICall(twistedPrompt, templateQuestionSchema, validateTemplateQuestions, 'template_questions', 'keep-going-twisted', req.userId);

        const allQuestions = [...(directResult.questions || []), ...(twistedResult.questions || [])];

        console.log(`✅ Generated Keep Going questions: ${directResult.questions?.length || 0} direct + ${twistedResult.questions?.length || 0} twisted = ${allQuestions.length} total`);

        res.json({
            success: true,
            questions: allQuestions,
            generatedAt: new Date(),
            focusAreas: weakAreas,
            template: {
                directQuestions: directResult.questions?.length || 0,
                twistedQuestions: twistedResult.questions?.length || 0,
                total: allQuestions.length
            }
        });

    } catch (error) {
        console.error('❌ Template Keep Going generation error:', error);
        res.status(500).json({
            error: 'Failed to generate Keep Going questions',
            details: error.message
        });
    }
});

app.get('/api/content/:type', authenticateToken, async (req, res) => {
    try {
        const { type } = req.params;

        if (req.userId === 'demo') {
            // Return demo content based on type
            const demoContent = {
                summary: {
                    overview: "This is sample AI content covering machine learning fundamentals",
                    keyPoints: ["Machine Learning is a subset of AI", "Neural networks are inspired by the brain", "Deep learning uses multiple layers"],
                    definitions: {
                        "Machine Learning": "Systems that learn from data without explicit programming",
                        "Neural Network": "Computing system inspired by biological neural networks"
                    }
                },
                flashcards: [
                    {
                        term: "Machine Learning",
                        definition: "A subset of AI that learns from data",
                        category: "AI Fundamentals",
                        importance: 5
                    }
                ],
                questions: {
                    allQuestions: [
                        {
                            question: "What is the primary characteristic that defines machine learning?",
                            options: ["Learning from data without explicit programming", "Using only rule-based systems", "Requiring manual updates for new scenarios", "Operating without any training data"],
                            correctAnswer: "Learning from data without explicit programming",
                            explanation: "Machine learning's key feature is its ability to learn and improve from data automatically, without being explicitly programmed for every scenario.",
                            difficulty: 2,
                            topic: "Machine Learning Fundamentals",
                            type: "direct",
                            learningObjective: "Understand the core definition of machine learning",
                            hints: ["Think about what makes ML different from traditional programming"],
                            commonMistakes: ["Confusing ML with simple automation"],
                            timeEstimate: "2 minutes"
                        },
                        {
                            question: "In a neural network, what role do weights play?",
                            options: ["They determine the strength of connections between neurons", "They count the number of layers", "They store the training data", "They determine the network architecture"],
                            correctAnswer: "They determine the strength of connections between neurons",
                            explanation: "Weights in neural networks control how much influence one neuron has on another, essentially determining the strength of connections.",
                            difficulty: 3,
                            topic: "Neural Networks",
                            type: "direct",
                            learningObjective: "Understand the function of weights in neural networks",
                            hints: ["Consider how neurons communicate with each other"],
                            commonMistakes: ["Thinking weights are just storage for data"],
                            timeEstimate: "2 minutes"
                        },
                        {
                            question: "What distinguishes deep learning from traditional machine learning?",
                            options: ["Multiple layers of neural networks", "Faster processing speed", "Less data requirements", "Simpler algorithms"],
                            correctAnswer: "Multiple layers of neural networks",
                            explanation: "Deep learning uses neural networks with multiple hidden layers (\"deep\" architecture) to learn complex patterns, unlike traditional ML which often uses simpler, single-layer approaches.",
                            difficulty: 3,
                            topic: "Deep Learning",
                            type: "direct",
                            learningObjective: "Differentiate deep learning from traditional ML approaches",
                            hints: ["The word 'deep' refers to the architecture"],
                            commonMistakes: ["Thinking deep learning is always better than traditional ML"],
                            timeEstimate: "2 minutes"
                        },
                        {
                            question: "What is tokenization in natural language processing?",
                            options: ["Breaking text into smaller units like words or sentences", "Translating between languages", "Checking grammar and spelling", "Generating new text content"],
                            correctAnswer: "Breaking text into smaller units like words or sentences",
                            explanation: "Tokenization is the process of splitting text into individual units (tokens) such as words, phrases, or sentences, which is a fundamental preprocessing step in NLP.",
                            difficulty: 2,
                            topic: "Natural Language Processing",
                            type: "direct",
                            learningObjective: "Understand basic NLP preprocessing techniques",
                            hints: ["Think about how you would break down a sentence for analysis"],
                            commonMistakes: ["Confusing tokenization with translation"],
                            timeEstimate: "2 minutes"
                        },
                        {
                            question: "What makes computer vision challenging compared to human vision?",
                            options: ["Computers lack contextual understanding and are sensitive to variations", "Computers process images too slowly", "Images contain too much information", "Computer screens have poor resolution"],
                            correctAnswer: "Computers lack contextual understanding and are sensitive to variations",
                            explanation: "Unlike humans who easily understand context and adapt to variations in lighting, angle, and perspective, computers struggle with these variations and need extensive training to achieve robust vision.",
                            difficulty: 3,
                            topic: "Computer Vision",
                            type: "direct",
                            learningObjective: "Understand the challenges in computer vision systems",
                            hints: ["Compare how easily humans recognize objects vs computers"],
                            commonMistakes: ["Thinking computer vision is just about image quality"],
                            timeEstimate: "2 minutes"
                        },
                        {
                            question: "Which type of machine learning would be best for email spam detection?",
                            options: ["Supervised learning with labeled spam/not spam examples", "Unsupervised learning without any labels", "Reinforcement learning with rewards", "Transfer learning from image recognition"],
                            correctAnswer: "Supervised learning with labeled spam/not spam examples",
                            explanation: "Supervised learning is ideal for spam detection because we can train the model using examples of emails that have been labeled as spam or not spam, allowing it to learn the patterns that distinguish between them.",
                            difficulty: 3,
                            topic: "ML Applications",
                            type: "direct",
                            learningObjective: "Apply ML concepts to real-world problems",
                            hints: ["Consider what type of training data would be available"],
                            commonMistakes: ["Thinking unsupervised learning works better without examples"],
                            timeEstimate: "3 minutes"
                        },
                        {
                            question: "What is the main advantage of using pre-trained models in deep learning?",
                            options: ["They reduce training time and data requirements", "They are always more accurate", "They use less computational power during inference", "They work without any additional training"],
                            correctAnswer: "They reduce training time and data requirements",
                            explanation: "Pre-trained models have already learned general features from large datasets, so they can be fine-tuned for specific tasks with less data and training time compared to training from scratch.",
                            difficulty: 3,
                            topic: "Transfer Learning",
                            type: "direct",
                            learningObjective: "Understand the benefits of transfer learning and pre-trained models",
                            hints: ["Think about reusing knowledge that's already been learned"],
                            commonMistakes: ["Assuming pre-trained models work perfectly without any adaptation"],
                            timeEstimate: "3 minutes"
                        },
                        {
                            question: "A hospital wants to implement an AI system to help doctors diagnose skin cancer from photos. What ethical considerations should they prioritize?",
                            options: ["Ensuring transparency, avoiding bias, and maintaining human oversight", "Only focusing on accuracy of the AI system", "Replacing doctors completely to reduce costs", "Making the system as complex as possible for better results"],
                            correctAnswer: "Ensuring transparency, avoiding bias, and maintaining human oversight",
                            explanation: "Medical AI systems require careful ethical consideration including transparent decision-making processes, bias testing across different demographics, and maintaining human doctors in the decision loop for patient safety and accountability.",
                            difficulty: 4,
                            topic: "AI Ethics in Healthcare",
                            type: "twisted",
                            learningObjective: "Apply ethical principles to real-world AI applications",
                            hints: ["Consider the life-and-death implications of medical AI decisions"],
                            commonMistakes: ["Focusing only on technical performance without considering ethical implications"],
                            timeEstimate: "4 minutes"
                        },
                        {
                            question: "You're building a recommendation system for a streaming platform. Users complain it only suggests popular content. How would you address this filter bubble problem?",
                            options: ["Introduce diversity metrics and exploration mechanisms in the algorithm", "Only recommend the most popular content to satisfy most users", "Let users manually search without any recommendations", "Use only collaborative filtering without content analysis"],
                            correctAnswer: "Introduce diversity metrics and exploration mechanisms in the algorithm",
                            explanation: "To break filter bubbles, recommendation systems should include diversity metrics to ensure variety, exploration mechanisms to introduce new content, and balance between user preferences and content discovery to provide a richer user experience.",
                            difficulty: 4,
                            topic: "Recommendation Systems Design",
                            type: "twisted",
                            learningObjective: "Design AI systems that balance user satisfaction with broader goals",
                            hints: ["Think about the trade-off between giving users what they want vs what they might discover"],
                            commonMistakes: ["Optimizing only for engagement metrics without considering user experience diversity"],
                            timeEstimate: "4 minutes"
                        },
                        {
                            question: "A self-driving car company wants to train their AI using data from different countries. What challenges might they face and how should they address them?",
                            options: ["Different traffic rules, road signs, and driving cultures require localized training data and testing", "All countries have the same traffic patterns, so one dataset works globally", "Just translate the text in road signs to local languages", "Use the same model everywhere since cars are universal"],
                            correctAnswer: "Different traffic rules, road signs, and driving cultures require localized training data and testing",
                            explanation: "Autonomous vehicles must account for local variations in traffic laws, road signage, driving behaviors, and cultural norms. This requires collecting diverse training data from each region and extensive local testing for safety and effectiveness.",
                            difficulty: 5,
                            topic: "AI Localization and Cultural Adaptation",
                            type: "twisted",
                            learningObjective: "Understand how AI systems must adapt to different cultural and regulatory contexts",
                            hints: ["Consider how driving rules and behaviors vary between countries"],
                            commonMistakes: ["Assuming a one-size-fits-all approach works for global AI deployment"],
                            timeEstimate: "5 minutes"
                        },
                        {
                            question: "A startup claims their AI can predict employee performance with 95% accuracy using resume data. As a consultant, what concerns would you raise?",
                            options: ["Potential bias, privacy issues, over-reliance on historical data, and legal compliance concerns", "The accuracy is too low and should be 100%", "They should only focus on technical skills from resumes", "This is perfect and should be implemented immediately"],
                            correctAnswer: "Potential bias, privacy issues, over-reliance on historical data, and legal compliance concerns",
                            explanation: "HR AI systems raise serious concerns including perpetuating hiring biases, violating privacy regulations, reinforcing historical inequalities, and potential legal issues with discrimination. High accuracy doesn't guarantee fairness or ethical implementation.",
                            difficulty: 5,
                            topic: "AI in Human Resources - Ethics and Compliance",
                            type: "twisted",
                            learningObjective: "Critically evaluate AI applications for ethical and practical concerns",
                            hints: ["Consider the potential negative impacts beyond just technical accuracy"],
                            commonMistakes: ["Focusing only on accuracy metrics without considering fairness and legal implications"],
                            timeEstimate: "5 minutes"
                        }
                    ]
                }
            };

            return res.json(demoContent[type] || { error: 'Content type not found' });
        }

        // For real users, fetch from database
        const session = await db.collection('studySessions').findOne({
            userId: req.userId
        });

        if (!session) {
            return res.status(404).json({ error: 'No study session found' });
        }

        res.json(session.content[type] || { error: 'Content type not found' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/subscription-status', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();
        const user = req.userId === 'demo' ? {
            subscription: { status: 'free', plan: 'free' }
        } : await db.collection('users').findOne({ _id: new ObjectId(req.userId) });

        // Ensure user exists with default subscription
        const userWithDefaults = user || { subscription: { status: 'free', plan: 'free' } };
        if (!userWithDefaults.subscription) {
            userWithDefaults.subscription = { status: 'free', plan: 'free' };
        }

        res.json({
            subscription: userWithDefaults.subscription
        });
    } catch (error) {
        console.error('Subscription status error:', error);
        res.status(500).json({ error: 'Failed to get subscription status' });
    }
});

// Error handling middleware with testing integration
app.use(backendTesting.errorTracker());

// Initialize database before starting server
async function startServer() {
    try {
        console.log('🔄 Initializing database...');
        await initializeDatabase();
        console.log('✅ Database initialized successfully');
        
        // Start server with testing checklist integration
        app.listen(PORT, '0.0.0.0', async () => {
            console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
            console.log(`📊 Health check: http://localhost:${PORT}/health`);
            console.log(`🔍 Testing status: http://localhost:${PORT}/api/testing-status`);
            console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:8080'}`);
            console.log(`🌍 Replit URL: https://${process.env.REPLIT_DEV_DOMAIN || 'your-repl-name.username.replit.dev'}`);

            // Run initial backend testing checklist
            console.log('🔍 Running initial backend testing checklist...');
            await backendTesting.runBackendChecklist(['logs', 'performance', 'security', 'database']);
            console.log('✅ Backend testing checklist complete');
        });
    } catch (error) {
        console.error('❌ Failed to initialize database:', error);
        process.exit(1);
    }
}

startServer();

module.exports = app;

process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await mongoClient.close();
    process.exit(0);
});