#!/bin/bash

# AI Test Agent Builder Setup Script

set -e

echo "🚀 Setting up AI Test Agent Builder..."

# Check prerequisites
echo "📋 Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+"
    exit 1
fi

if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed. Please install Python 3.10+"
    exit 1
fi

if ! command -v psql &> /dev/null; then
    echo "⚠️  PostgreSQL is not installed. Database setup will be skipped."
fi

# Setup backend
echo "📦 Setting up backend..."
cd backend
npm install
cd ..

# Setup executor
echo "🐍 Setting up executor..."
cd executor
pip install -r requirements.txt
playwright install chromium
cd ..

# Create necessary directories
echo "📁 Creating directories..."
mkdir -p logs
mkdir -p reports
mkdir -p videos

# Copy environment file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
    cp .env.example .env
    echo "⚠️  Please edit .env with your configuration"
fi

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env with your database and API keys"
echo "2. Create database: createdb aitestagentbuilder"
echo "3. Run migrations: cd backend && npm run db:migrate"
echo "4. Start backend: cd backend && npm run dev"

