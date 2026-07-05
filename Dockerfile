# Use official Node.js runtime as base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --break-system-packages

# Copy all app files
COPY . .

# Expose port
EXPOSE 3000

# Start the server
CMD ["npm", "start"]
