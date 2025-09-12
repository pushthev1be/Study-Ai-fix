# StudyMaster AI - Complete Learning Platform

An AI-powered study platform that helps students prepare for exams by uploading documents, generating summaries, creating practice questions, and using spaced repetition.

## Features

- 📚 **Document Processing**: Upload PDF, DOC, TXT files and extract text content
- 🤖 **AI Content Generation**: Generate summaries, practice questions, flashcards using OpenAI GPT-4
- 💬 **AI Chat Tutor**: Interactive chat with AI tutor based on your study materials
- 🔄 **Spaced Repetition**: SM-2 algorithm for optimal learning intervals
- 📊 **Analytics**: Track study time, accuracy, and progress
- 🎯 **Knowledge Gap Analysis**: Identify areas that need more focus
- 📅 **Study Plans**: Personalized daily study schedules
- 🔐 **Authentication**: Secure user registration and login with JWT

## Tech Stack

### Backend
- Node.js + Express
- MongoDB for data storage
- Redis for caching (optional)
- OpenAI API for AI content generation
- JWT for authentication
- Multer for file uploads
- PDF-parse, Mammoth for document processing

### Frontend
- Modern HTML5 + CSS3 + JavaScript
- Glassmorphism UI design
- Responsive layout
- Real-time chat interface

### Deployment
- Docker + Docker Compose
- NGINX reverse proxy
- Production-ready configuration

## Quick Start

### Prerequisites

1. **Node.js 18+**
2. **MongoDB** (local or cloud)
3. **OpenAI API Key** (required for AI features)
4. **Docker** (optional, for containerized deployment)

### Environment Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd studymaster-ai
```

2. Install backend dependencies:
```bash
cd backend
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` with your actual values:
```env
OPENAI_API_KEY=sk-your-openai-api-key-here
MONGODB_URI=mongodb://localhost:27017/studymaster
JWT_SECRET=your-super-secret-jwt-key-change-this
```

### Running Locally

#### Option 1: Manual Setup

1. **Start MongoDB**:
```bash
# If using Docker
docker run -d -p 27017:27017 --name mongodb mongo:latest

# Or use your local MongoDB installation
```

2. **Start the backend**:
```bash
cd backend
npm run dev
```

3. **Serve the frontend**:
```bash
cd frontend
# Use any static file server, e.g.:
python -m http.server 8080
# Or
npx serve .
```

4. **Access the application**:
- Frontend: http://localhost:8080
- Backend API: http://localhost:3000
- Health check: http://localhost:3000/health

#### Option 2: Docker Compose

1. **Set environment variables**:
```bash
export OPENAI_API_KEY=sk-your-openai-api-key-here
export JWT_SECRET=your-super-secret-jwt-key
```

2. **Start all services**:
```bash
docker-compose up -d
```

3. **Access the application**:
- Application: http://localhost
- Backend API: http://localhost:3000

## API Endpoints

### Authentication
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login

### File Management
- `POST /api/upload` - Upload and process study materials

### AI Content Generation
- `POST /api/generate` - Generate study content (summaries, questions, flashcards)
- `POST /api/chat` - Chat with AI tutor

### Spaced Repetition
- `POST /api/spaced-repetition/review` - Review flashcard
- `GET /api/spaced-repetition/due/:userId` - Get due cards

### Analytics
- `GET /api/stats/:userId` - Get user statistics
- `POST /api/stats/update-time` - Update study time

## Configuration

### Required API Keys

1. **OpenAI API Key** (Required)
   - Sign up at https://platform.openai.com/
   - Create an API key
   - Set monthly usage limits to control costs

2. **Stripe Keys** (Optional, for payments)
   - Sign up at https://stripe.com/
   - Get publishable and secret keys

### Cost Optimization

The platform includes several cost optimization features:

- **Smart Model Selection**: Uses GPT-3.5 for simple tasks, GPT-4 for complex analysis
- **Content Caching**: Redis caching to avoid repeated API calls
- **Rate Limiting**: Prevents API abuse
- **Text Truncation**: Limits input text length to control token usage

### Database Schema

The application uses the following MongoDB collections:

- `users` - User accounts and statistics
- `files` - Uploaded documents and extracted text
- `studySessions` - Generated study content sessions
- `flashcards` - Spaced repetition cards
- `chatHistory` - AI chat conversations
- `dailyStats` - Daily study statistics

## Development

### Project Structure
```
studymaster-ai/
├── backend/
│   ├── server.js          # Main server file
│   ├── package.json       # Dependencies
│   ├── .env              # Environment variables
│   └── uploads/          # File upload directory
├── frontend/
│   ├── index.html        # Main frontend file
│   └── api-client.js     # API integration
├── docker-compose.yml    # Docker services
├── nginx.conf           # NGINX configuration
└── README.md
```

### Adding New Features

1. **Backend**: Add new routes in `server.js`
2. **Frontend**: Update `index.html` and `api-client.js`
3. **Database**: Add new collections as needed
4. **API**: Update the API client class

## Deployment

### Production Deployment

1. **Set up environment variables**:
```bash
export NODE_ENV=production
export OPENAI_API_KEY=your-production-key
export MONGODB_URI=your-production-mongodb-uri
export JWT_SECRET=your-production-jwt-secret
```

2. **Deploy with Docker**:
```bash
docker-compose -f docker-compose.prod.yml up -d
```

3. **Set up domain and SSL**:
- Configure your domain to point to the server
- Set up SSL certificates (Let's Encrypt recommended)
- Update NGINX configuration for HTTPS

### Monitoring

- Monitor OpenAI API usage in the OpenAI dashboard
- Set up MongoDB monitoring
- Use application logs for debugging
- Monitor server resources (CPU, memory, disk)

## Troubleshooting

### Common Issues

1. **OpenAI API Errors**:
   - Check API key validity
   - Verify account has sufficient credits
   - Check rate limits

2. **File Upload Issues**:
   - Ensure uploads directory exists and is writable
   - Check file size limits (default: 10MB)
   - Verify supported file types (PDF, DOC, TXT)

3. **Database Connection**:
   - Verify MongoDB is running
   - Check connection string format
   - Ensure database permissions

4. **Authentication Issues**:
   - Verify JWT secret is set
   - Check token expiration (default: 7 days)
   - Clear browser localStorage if needed

### Logs

- Backend logs: Check console output or log files
- Frontend errors: Check browser developer console
- Database logs: Check MongoDB logs
- NGINX logs: Check access and error logs

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support and questions:
- Create an issue in the repository
- Check the troubleshooting section
- Review the API documentation

## Roadmap

- [ ] Mobile app development
- [ ] Advanced analytics dashboard
- [ ] Integration with learning management systems
- [ ] Multi-language support
- [ ] Collaborative study features
- [ ] Advanced AI models integration
