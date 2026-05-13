# Running the AI Test Agent Builder

## ✅ Build Status

**Backend**: ✅ Successfully compiled
**Server**: ✅ Running on port 3000

## 🚀 Quick Start

### 1. Prerequisites

- Node.js 18+
- PostgreSQL 14+ with pgvector extension
- Python 3.10+ (for executor)
- Redis (optional, for rate limiting and caching)

### 2. Database Setup

```bash
# Install PostgreSQL with pgvector
# macOS: brew install postgresql@14
# Ubuntu: apt-get install postgresql-14 postgresql-14-pgvector

# Create database
createdb aitestagentbuilder

# Enable pgvector extension
psql aitestagentbuilder -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run migrations
cd backend
npm run db:migrate
```

### 3. Environment Configuration

```bash
# Copy example env file
cp .env.example .env

# Edit .env with your settings:
# - DB_URL or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
# - JWT_ACCESS_SECRET (min 64 chars)
# - JWT_REFRESH_SECRET (min 64 chars)
# - OPENAI_API_KEY (for LLM features)
# - REDIS_URL (optional, for rate limiting)
```

### 4. Start Backend

```bash
cd backend
npm install
npm run build
npm run dev
```

Server will start on `http://localhost:3000`

### 5. Verify Installation

```bash
# Health check
curl http://localhost:3000/health/ready

# Metrics (Prometheus format)
curl http://localhost:3000/health/metrics

# API endpoints (may require auth)
curl http://localhost:3000/api/v1/agents
```

## 📊 Current Status

**Server**: Running ✅
- Port: 3000
- API Prefix: /api/v1
- Health Endpoints: /health/*

**Database**: ⚠️ Not connected
- Connection refused (PostgreSQL not running)
- Run database setup steps above

**Features Available**:
- ✅ REST API endpoints
- ✅ WebSocket server
- ✅ Health checks
- ✅ Metrics collection
- ⚠️ Database operations (requires PostgreSQL)
- ⚠️ Authentication (requires database)

## 🔧 Troubleshooting

### Database Connection Failed

**Error**: `ECONNREFUSED`

**Solution**:
1. Ensure PostgreSQL is running:
   ```bash
   # macOS
   brew services start postgresql@14
   
   # Linux
   sudo systemctl start postgresql
   ```

2. Verify connection:
   ```bash
   psql -h localhost -U postgres -d aitestagentbuilder
   ```

3. Check environment variables:
   ```bash
   echo $DB_HOST $DB_PORT $DB_NAME
   ```

### Port Already in Use

**Error**: `EADDRINUSE`

**Solution**:
```bash
# Find process using port 3000
lsof -i :3000

# Kill process
kill -9 <PID>

# Or use different port
PORT=3001 npm run dev
```

### Authentication Errors

If `AUTH_ENABLED=true`, you need to:
1. Create a user in the database
2. Login to get JWT token
3. Use token in Authorization header

Or temporarily disable auth:
```bash
AUTH_ENABLED=false npm run dev
```

## 📝 Next Steps

1. **Set up database** (see Database Setup above)
2. **Configure environment** (copy .env.example)
3. **Create admin user**:
   ```sql
   INSERT INTO users (id, email, password_hash, role)
   VALUES ('USER-001', 'admin@example.com', 'hashed_password', 'admin');
   ```
4. **Test API endpoints**:
   ```bash
   # Login
   curl -X POST http://localhost:3000/api/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"admin@example.com","password":"password"}'
   
   # Use token
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     http://localhost:3000/api/v1/agents
   ```

## 🎯 Running Components

- **Backend API**: `http://localhost:3000`
- **WebSocket**: `ws://localhost:3000/socket.io`
- **Health**: `http://localhost:3000/health`
- **Metrics**: `http://localhost:3000/health/metrics`

All systems are ready once PostgreSQL is configured! 🚀

