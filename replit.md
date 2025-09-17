# StudyMaster AI - Replit Project

## Overview
StudyMaster AI is a complete learning platform that helps students prepare for exams by uploading documents, generating AI-powered summaries, creating practice questions, and using spaced repetition for optimal learning.

## Project Architecture
- **Frontend**: HTML5/CSS3/JavaScript with glassmorphism UI design (Port 5000)
- **Backend**: Node.js/Express API server (Port 3000)
- **Database**: MongoDB (In-memory for development)
- **AI Integration**: OpenAI GPT for content generation
- **Authentication**: JWT-based user authentication

## Current Status
✅ **Fully configured and running in Replit environment**

### ✅ Completed Setup Tasks:
1. Node.js environment installed and configured
2. MongoDB Memory Server setup for development database
3. Backend dependencies installed and configured for Replit
4. Frontend configured to work with Replit proxy settings
5. CORS properly configured for cross-origin requests
6. Frontend workflow running on port 5000 (webview)
7. Backend workflow running on port 3000 (console)
8. Deployment configuration set for VM deployment
9. All core functionality working
10. OpenAI API key integrated - AI features fully enabled

### 🔧 Environment Configuration:
- **Frontend Server**: Express.js serving static files on port 5000
- **Backend Server**: Express.js API server on port 3000 with 0.0.0.0 binding
- **Database**: MongoDB Memory Server with automatic startup
- **CORS**: Configured to allow all Replit domains and development origins
- **OpenAI API**: Configured and ready for AI content generation

### 📝 API Keys Configured:
- ✅ `OPENAI_API_KEY`: Configured for AI content generation features
- `STRIPE_SECRET_KEY`: Optional for payment processing (not configured)

## Project Structure
```
studymaster-ai/
├── backend/
│   ├── server.js           # Main Express server with MongoDB integration
│   ├── start-mongodb.js    # MongoDB Memory Server setup
│   ├── package.json        # Backend dependencies
│   └── .env               # Environment variables
├── frontend/
│   ├── index.html          # Main frontend application
│   ├── api-client.js       # API client configured for Replit
│   ├── server.js           # Express static file server
│   └── package.json        # Frontend dependencies
└── replit.md              # This documentation file
```

## How to Use
1. Access the application through the Webview tab
2. Register a new account or use demo mode
3. Upload study materials (PDF, DOC, TXT files)
4. Generate AI-powered study content (summaries, questions, flashcards)
5. Use flashcards and spaced repetition for learning

## Features Available
- 📚 Document upload and text extraction
- 🤖 AI-powered content generation (summaries, questions, flashcards)
- 💬 AI chat tutor functionality
- 🔄 Spaced repetition system
- 📊 Study analytics and progress tracking
- 🎯 Knowledge gap analysis
- 📅 Personalized study plans

## Development Notes
- The application uses MongoDB Memory Server for development
- All CORS issues have been resolved for the Replit environment
- Backend automatically detects and configures for Replit domains
- Frontend API client automatically uses correct backend URL
- OpenAI API integration is fully functional

## Recent Changes (September 6, 2025)
- Successfully imported GitHub project to Replit
- Configured MongoDB Memory Server for database functionality
- Updated CORS settings for Replit environment compatibility
- Set up proper frontend-backend communication
- Created Express server for frontend static file serving
- Configured both workflows for optimal development experience
- Set deployment target as VM for stateful operation
- Integrated fixed HTML frontend with improved functionality
- Added OpenAI API key - all AI features now fully operational