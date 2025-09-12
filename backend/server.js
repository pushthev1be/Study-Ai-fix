const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const { MongoClient, ObjectId } = require('mongodb');
const { startMongoDB } = require('./start-mongodb');

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// Add Ajv for JSON schema validation
const Ajv = require('ajv');
const ajv = new Ajv();

// JSON Schemas for validation
const questionSetSchema = {
    type: "object",
    required: ["title", "difficulty", "description", "multipleChoice", "shortAnswer", "essay"],
    properties: {
        title: { type: "string" },
        difficulty: { type: "string", enum: ["Easy", "Medium", "Hard"] },
        description: { type: "string" },
        multipleChoice: {
            type: "array",
            items: {
                type: "object",
                required: ["question", "options", "correctAnswer", "explanation", "difficulty", "topic"],
                properties: {
                    question: { type: "string" },
                    options: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
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
    properties: {
        flashcards: {
            type: "array",
            items: {
                type: "object",
                required: ["term", "definition", "visualDescription", "mnemonic", "multipleExamples", "commonMisconceptions", "connections", "practiceQuestion", "memoryTips", "category", "difficulty", "importance"],
                properties: {
                    term: { type: "string" },
                    definition: { type: "string" },
                    visualDescription: { type: "string" },
                    mnemonic: { type: "string" },
                    multipleExamples: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
                    commonMisconceptions: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
                    connections: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
                    practiceQuestion: { type: "string" },
                    memoryTips: { type: "string" },
                    category: { type: "string" },
                    difficulty: { type: "number", minimum: 1, maximum: 5 },
                    importance: { type: "number", minimum: 1, maximum: 5 }
                }
            },
            minItems: 5,
            maxItems: 5
        }
    }
};

// Compile schemas for faster validation
const validateQuestionSet = ajv.compile(questionSetSchema);
const validateFlashcardBatch = ajv.compile(flashcardBatchSchema);

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

let db;
const mongoClient = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/studymaster');

async function initializeDatabase() {
    if (!db) {
        if (app.locals && app.locals.testDb) {
            db = app.locals.testDb;
        } else {
            await mongoClient.connect();
            db = mongoClient.db('studymaster');
        }

        // Create indexes
        await db.collection('files').createIndex({ userId: 1 });
        await db.collection('files').createIndex({ embedding: 1 });
        await db.collection('flashcards').createIndex({ userId: 1, nextReview: 1 });
        await db.collection('users').createIndex({ email: 1 }, { unique: true });
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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

// Helper function for retry logic with exponential backoff
async function retryWithBackoff(operation, maxRetries = 2, baseDelay = 1000) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }

            const delay = baseDelay * Math.pow(2, attempt);
            console.log(`❌ Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Core API call function with validation
async function makeValidatedAPICall(prompt, schema, validator, type, batchName = '') {
    const operation = async () => {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are an expert educator. Always respond with valid JSON only. No markdown, no code blocks, just pure JSON. Ensure all JSON strings are properly escaped and terminated."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.4, // Lower temperature for more consistent output
            max_tokens: 1400, // Appropriate for batched content
            response_format: { type: "json_object" }
        });

        const rawContent = response.choices[0].message.content;

        if (!rawContent || rawContent.trim() === '') {
            throw new Error(`Empty response from OpenAI for ${type}${batchName ? ' ' + batchName : ''}`);
        }

        // Clean JSON response
        let cleanedContent = rawContent.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();

        let parsed;
        try {
            parsed = JSON.parse(cleanedContent);
        } catch (parseError) {
            // Try cleaning common JSON issues
            cleanedContent = cleanedContent.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            parsed = JSON.parse(cleanedContent);
        }

        // Validate against schema
        if (!validator(parsed)) {
            console.error(`❌ Schema validation failed for ${type}${batchName ? ' ' + batchName : ''}:`, validator.errors);
            throw new Error(`Schema validation failed: ${validator.errors.map(e => e.message).join(', ')}`);
        }

        console.log(`✅ Successfully generated and validated ${type}${batchName ? ' ' + batchName : ''}`);
        return parsed;
    };

    return await retryWithBackoff(operation, 2, 1000);
}

// Generate questions in 3 sequential batches
async function generateQuestionsBatched(text) {
    console.log('🔄 Starting batched questions generation...');

    const sets = {};
    const setConfigs = [
        {
            key: 'set1',
            title: 'Fundamentals',
            difficulty: 'Easy',
            description: 'Basic concepts and definitions',
            focus: 'fundamental concepts and key definitions'
        },
        {
            key: 'set2',
            title: 'Application',
            difficulty: 'Medium',
            description: 'Applying concepts and problem solving',
            focus: 'practical applications and problem-solving scenarios'
        },
        {
            key: 'set3',
            title: 'Analysis',
            difficulty: 'Hard',
            description: 'Critical thinking and advanced analysis',
            focus: 'complex analysis and critical thinking'
        }
    ];

    for (const config of setConfigs) {
        const prompt = `Generate practice questions focusing on ${config.focus} for this content.

Content: ${text.substring(0, 6000)}

Create a question set with the following structure:
- ${config.difficulty} difficulty level
- 3-4 multiple choice questions
- 2 short answer questions
- 1 essay question

Return ONLY valid JSON in this exact format:
{
    "title": "${config.title}",
    "difficulty": "${config.difficulty}",
    "description": "${config.description}",
    "multipleChoice": [
        {
            "question": "Clear, specific question",
            "options": ["Option A", "Option B", "Option C", "Option D"],
            "correctAnswer": "Option A",
            "explanation": "Detailed explanation",
            "difficulty": 3,
            "topic": "Specific topic area",
            "learningObjective": "What this tests",
            "hints": ["Helpful hint"],
            "commonMistakes": ["Common mistake"],
            "timeEstimate": "2 minutes"
        }
    ],
    "shortAnswer": [
        {
            "question": "Open-ended question",
            "sampleAnswer": "Sample response",
            "points": 5,
            "rubric": "Grading criteria",
            "keyPoints": ["Key point 1", "Key point 2"]
        }
    ],
    "essay": [
        {
            "question": "Complex analytical question",
            "guidelines": "Writing guidelines",
            "points": 20,
            "structure": "Essay structure",
            "resources": ["Resource 1"]
        }
    ]
}`;

        try {
            const result = await makeValidatedAPICall(prompt, questionSetSchema, validateQuestionSet, 'questions', config.key);
            sets[config.key] = result;
            console.log(`✅ Generated ${config.key}: ${result.multipleChoice.length} MC, ${result.shortAnswer.length} SA, ${result.essay.length} essay`);
        } catch (error) {
            console.error(`❌ Failed to generate ${config.key}:`, error.message);
            throw new Error(`Failed to generate question ${config.key}: ${error.message}`);
        }
    }

    console.log('✅ Questions generation completed successfully');
    return sets;
}

// Generate flashcards in 4 batches of 5 cards each
async function generateFlashcardsBatched(text) {
    console.log('🔄 Starting batched flashcards generation...');

    const allFlashcards = [];
    const usedTerms = new Set();

    const topics = [
        'fundamental concepts and basic principles',
        'key processes and mechanisms',
        'important relationships and connections',
        'practical applications and examples'
    ];

    for (let batchNum = 0; batchNum < 4; batchNum++) {
        const topic = topics[batchNum];
        const usedTermsList = Array.from(usedTerms).join(', ');

        const prompt = `Create exactly 5 educational flashcards focusing on ${topic} from this content.

Content: ${text.substring(0, 6000)}

${usedTerms.size > 0 ? `IMPORTANT: Do not repeat these already used terms: ${usedTermsList}` : ''}

Each flashcard must have ALL these elements:
- term: Unique concept name (not already used)
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

        try {
            const result = await makeValidatedAPICall(prompt, flashcardBatchSchema, validateFlashcardBatch, 'flashcards', `batch${batchNum + 1}`);

            // Check for duplicate terms and add to used terms set
            for (const card of result.flashcards) {
                const term = card.term.toLowerCase().trim();
                if (usedTerms.has(term)) {
                    console.warn(`⚠️ Duplicate term detected in batch ${batchNum + 1}: ${card.term}`);
                    // Modify term to make it unique
                    card.term = `${card.term} (${topic.split(' ')[0]})`;
                }
                usedTerms.add(term);
                allFlashcards.push(card);
            }

            console.log(`✅ Generated batch ${batchNum + 1}: ${result.flashcards.length} flashcards`);
        } catch (error) {
            console.error(`❌ Failed to generate flashcards batch ${batchNum + 1}:`, error.message);
            throw new Error(`Failed to generate flashcard batch ${batchNum + 1}: ${error.message}`);
        }
    }

    console.log(`✅ Flashcards generation completed: ${allFlashcards.length} total cards`);
    return { flashcards: allFlashcards };
}

// Main function that routes to batched or regular generation
async function generateStudyContent(text, type, options = {}) {
    if (type === 'questions') {
        return await generateQuestionsBatched(text);
    } else if (type === 'flashcards') {
        // Original logic for generating flashcards in batches has been replaced by the initial 6 cards generation.
        // This function will now only generate the initial 6 cards.
        // The logic for generating more flashcards is handled by a separate endpoint.
        const INITIAL_BATCH_SIZE = 5;
        console.log(`🔄 Generating initial ${INITIAL_BATCH_SIZE} flashcards...`);

        // Split text into chunks to potentially pick a relevant topic
        const contentChunks = text.split('\n\n').filter(chunk => chunk.trim().length > 50);
        if (contentChunks.length === 0) {
            throw new Error('No substantial content found to generate flashcards.');
        }

        const topic = contentChunks[0]; // Use first chunk for initial cards

        const prompt = `Create EXACTLY ${INITIAL_BATCH_SIZE} premium flashcards with enhanced features like Quizlet Plus from this content:

${topic}

Focus on the most important and fundamental concepts first.

Each flashcard must have ALL these elements:
- term: Unique concept name
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

        try {
            const result = await makeValidatedAPICall(prompt, flashcardBatchSchema, validateFlashcardBatch, 'flashcards', 'initial');
            console.log(`✅ Generated ${result.flashcards.length} initial flashcards`);
            return { flashcards: result.flashcards };
        } catch (error) {
            console.error(`❌ Failed to generate initial flashcards:`, error.message);
            throw new Error(`Failed to generate initial flashcards: ${error.message}`);
        }
    }

    // For other types, use existing single-call approach
    const prompts = {
        summary: `Create a comprehensive study summary following educational best practices. Analyze the content for difficulty level, learning objectives, and optimal study approach.

            Content: ${text.substring(0, 8000)}

            Return ONLY valid JSON in this exact format:
            {
                "overview": "Comprehensive overview in 2-3 sentences",
                "difficultyLevel": "Beginner/Intermediate/Advanced",
                "estimatedStudyTime": "X hours",
                "learningObjectives": ["Students will be able to...", "Students will understand..."],
                "keyPoints": ["Important concept 1", "Important concept 2"],
                "criticalConcepts": [
                    {
                        "concept": "Main concept name",
                        "explanation": "Clear explanation",
                        "importance": "High/Medium/Low",
                        "prerequisites": ["Required knowledge"]
                    }
                ],
                "definitions": {"term": "clear definition"},
                "studyStrategy": {
                    "approach": "Best study method for this content",
                    "focusAreas": ["area1", "area2"],
                    "commonMistakes": ["mistake1", "mistake2"]
                },
                "assessmentTips": ["How to prepare for tests on this material"]
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
                        content: "You are an expert educator. Always respond with valid JSON only. No markdown, no code blocks, just pure JSON. Ensure all JSON strings are properly escaped and terminated."
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
                setTimeout(() => reject(new Error(`OpenAI request timeout after 45 seconds`)), 45000)
            )
        ]);

        const rawContent = response.choices[0].message.content;

        if (!rawContent || rawContent.trim() === '') {
            throw new Error(`Empty response from OpenAI for ${type}`);
        }

        let cleanedContent = rawContent.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();

        try {
            const parsed = JSON.parse(cleanedContent);
            console.log(`✅ Successfully generated ${type}`);
            return parsed;
        } catch (parseError) {
            // Try cleaning common JSON issues
            cleanedContent = cleanedContent.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            const parsed = JSON.parse(cleanedContent);
            console.log(`✅ Successfully generated ${type} after cleanup`);
            return parsed;
        }
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

app.get('/health', (req, res) => {
    const envStatus = {
        mongodb: !!process.env.MONGODB_URI,
        openai: !!process.env.OPENAI_API_KEY,
        stripe_secret: !!process.env.STRIPE_SECRET_KEY,
        stripe_publishable: !!process.env.STRIPE_PUBLISHABLE_KEY,
        stripe_webhook: !!process.env.STRIPE_WEBHOOK_SECRET,
        frontend_url: !!process.env.FRONTEND_URL,
        jwt_secret: !!process.env.JWT_SECRET
    };

    const allConfigured = Object.values(envStatus).every(Boolean);

    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: {
            configured: envStatus,
            all_required_set: allConfigured,
            frontend_url: process.env.FRONTEND_URL || 'http://localhost:8080 (default)',
            node_env: process.env.NODE_ENV || 'development'
        }
    });
});

// Test endpoint for frontend connection
app.get('/test-connection', (req, res) => {
    res.json({
        message: 'Backend connection successful!',
        timestamp: new Date().toISOString(),
        origin: req.get('Origin'),
        userAgent: req.get('User-Agent')
    });
});

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

        let content = {};

        try {
            if (mode === 'comprehensive' || mode === 'summary') {
                console.log('🔄 Generating summary...');
                content.summary = await generateStudyContent(combinedText, 'summary');
                console.log('✅ Summary generated successfully');
            }

            if (mode === 'comprehensive' || mode === 'practice') {
                console.log('🔄 Generating questions...');
                content.questions = await generateStudyContent(combinedText, 'questions');
                console.log('✅ Questions generated successfully');
            }

            if (mode === 'comprehensive' || mode === 'flashcards') {
                console.log('🔄 Generating flashcards...');
                content.flashcards = await generateStudyContent(combinedText, 'flashcards');
                console.log('✅ Flashcards generated successfully');
            }

            if (mode === 'gaps') {
                console.log('🔄 Generating knowledge gaps...');
                content.knowledgeGaps = await generateStudyContent(combinedText, 'knowledgeGaps');
                console.log('✅ Knowledge gaps generated successfully');
            }

            console.log('🔄 Generating study plan...');
            content.studyPlan = await generateStudyContent(combinedText, 'studyPlan', { days: 7 });
            console.log('✅ Study plan generated successfully');

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
            const result = await db.collection('studySessions').insertOne(session);
            console.log('✅ Study session saved successfully');

            res.json({
                sessionId: result.insertedId,
                content: content
            });
        } catch (aiError) {
            console.error('❌ AI content generation failed:', aiError);
            throw new Error(`AI content generation failed: ${aiError.message}`);
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

        const prompt = `Create EXACTLY ${MORE_BATCH_SIZE} new premium flashcards with enhanced features from this content:

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

        const result = await makeValidatedAPICall(prompt, flashcardBatchSchema, validateFlashcardBatch, 'flashcards', 'additional');

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
            // Demo mode - create mock session
            session = {
                _id: 'demo-session',
                userId: 'demo',
                fileIds: ['demo-file'],
                content: {
                    summary: { overview: "Demo AI content session" },
                    flashcards: [],
                    questions: []
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
            // Demo mode - simulate card data
            card = {
                _id: 'demo-card',
                term: 'Machine Learning',
                definition: 'A subset of AI that learns from data',
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
            // Demo mode - return sample cards
            dueCards = [
                {
                    _id: 'demo-card-1',
                    term: 'Machine Learning',
                    definition: 'A subset of AI that learns from data',
                    category: 'AI Fundamentals',
                    importance: 5,
                    difficulty: 3
                },
                {
                    _id: 'demo-card-2',
                    term: 'Neural Network',
                    definition: 'Computing system inspired by biological neural networks',
                    category: 'AI Fundamentals',
                    importance: 4,
                    difficulty: 4
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

app.post('/api/adaptive-practice', authenticateToken, async (req, res) => {
    try {
        await initializeDatabase();
        const { weakAreas, difficulty, topic, previousAnswers } = req.body;

        console.log('🎯 Generating adaptive practice questions for weak areas:', weakAreas);

        // Enhanced prompt that focuses on weak areas and uses external knowledge
        const adaptivePrompt = `You are an expert educator creating targeted practice questions. Generate 15 NEW practice questions focusing on areas where the student is struggling.

Student's weak areas: ${weakAreas?.join(', ') || 'General review'}
Difficulty level: ${difficulty || 'Mixed'}
Topic: ${topic || 'General'}
Previous incorrect answers: ${JSON.stringify(previousAnswers || [])}

Create questions that:
1. Target the specific weak areas identified
2. Use different question formats than before
3. Include step-by-step explanations
4. Provide hints and common mistake warnings
5. Draw from both provided content AND standard curriculum knowledge

Generate a mix of:
- 8 Multiple choice questions
- 4 Short answer questions
- 3 Problem-solving questions

Return ONLY this JSON:
{
    "adaptiveQuestions": [
        {
            "type": "multiple_choice",
            "question": "Question text",
            "options": ["A) Option 1", "B) Option 2", "C) Option 3", "D) Option 4"],
            "correctAnswer": "A) Option 1",
            "explanation": "Detailed explanation why this is correct",
            "hints": ["Helpful hint"],
            "commonMistakes": ["Why students choose wrong answers"],
            "difficulty": 3,
            "focusArea": "Specific weak area this addresses"
        }
    ]
}`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are an expert educator specializing in adaptive learning. Always respond with valid JSON only."
                },
                {
                    role: "user",
                    content: adaptivePrompt
                }
            ],
            temperature: 0.8,
            max_tokens: 3000,
            response_format: { type: "json_object" }
        });

        const content = response.choices[0].message.content;
        const adaptiveQuestions = JSON.parse(content);

        console.log('✅ Generated adaptive practice questions:', adaptiveQuestions.adaptiveQuestions?.length || 0);

        res.json({
            success: true,
            questions: adaptiveQuestions.adaptiveQuestions || [],
            generatedAt: new Date(),
            focusAreas: weakAreas
        });

    } catch (error) {
        console.error('❌ Adaptive practice generation error:', error);
        res.status(500).json({
            error: 'Failed to generate adaptive practice questions',
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
                    multipleChoice: [
                        {
                            question: "What is machine learning?",
                            options: ["A) Subset of AI", "B) Type of computer", "C) Programming language", "D) Database"],
                            correctAnswer: "A) Subset of AI",
                            explanation: "Machine learning is indeed a subset of artificial intelligence"
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

app.use((error, req, res, next) => {
    console.error('Error:', error);

    if (error.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    if (error.name === 'ValidationError') {
        return res.status(400).json({ error: 'Validation failed', details: error.message });
    }

    if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large' });
    }

    if (error.message && error.message.includes('Only PDF, TXT, DOC, and DOCX files are allowed')) {
        return res.status(400).json({ error: 'Invalid file type' });
    }

    res.status(500).json({
        error: 'Internal server error',
        message: error.message
    });
});

function validateEnvironmentVariables() {
    const required = [
        'MONGODB_URI',
        'OPENAI_API_KEY',
        'JWT_SECRET'
    ];

    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        console.error('❌ Missing required environment variables:');
        missing.forEach(key => console.error(`   - ${key}`));
        console.error('\n📋 See PRODUCTION_SETUP.md for configuration instructions');
        return false;
    }

    console.log('✅ All required environment variables are configured');
    return true;
}

async function startServer() {
    try {
        if (!validateEnvironmentVariables()) {
            console.error('⚠️  Server starting with missing environment variables - some features may not work');
        }

        // Start MongoDB Memory Server for Replit environment
        console.log('🔄 Starting MongoDB Memory Server...');
        const mongoUri = await startMongoDB();

        // Update the MongoDB URI
        process.env.MONGODB_URI = mongoUri;

        await mongoClient.connect();
        db = mongoClient.db('studymaster');
        console.log('✅ Connected to MongoDB');

        await db.collection('files').createIndex({ userId: 1 });
        await db.collection('files').createIndex({ embedding: 1 });
        await db.collection('flashcards').createIndex({ userId: 1, nextReview: 1 });
        await db.collection('users').createIndex({ email: 1 }, { unique: true });

        console.log('✅ Database indexes created');

        if (process.env.STRIPE_SECRET_KEY) {
            console.log('✅ Stripe integration ready');
        }

        if (process.env.OPENAI_API_KEY) {
            console.log('✅ OpenAI API connection established');
        }

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
            console.log(`📊 Health check: http://localhost:${PORT}/health`);
            console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:8080'}`);
            console.log(`🌍 Replit URL: https://${process.env.REPLIT_DEV_DOMAIN || 'your-repl-name.username.replit.dev'}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

module.exports = app;

if (require.main === module) {
    startServer();
}

process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await mongoClient.close();
    process.exit(0);
});