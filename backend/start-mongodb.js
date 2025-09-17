const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;

async function startMongoDB() {
    try {
        console.log('🔄 Starting MongoDB Memory Server...');
        mongod = await MongoMemoryServer.create({
            instance: {
                dbName: 'studymaster'
                // Let MongoDB Memory Server choose its own port automatically
            }
        });
        
        const uri = mongod.getUri();
        console.log('✅ MongoDB Memory Server started successfully!');
        console.log('📍 Connection URI:', uri);
        
        // Set environment variable for the server
        process.env.MONGODB_URI = uri;
        
        return uri;
    } catch (error) {
        console.error('❌ Failed to start MongoDB Memory Server:', error);
        throw error;
    }
}

async function stopMongoDB() {
    if (mongod) {
        await mongod.stop();
        console.log('MongoDB Memory Server stopped');
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await stopMongoDB();
    process.exit(0);
});

module.exports = { startMongoDB, stopMongoDB };