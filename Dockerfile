FROM node:24 AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY . ./

# Create a non-root user for security
# RUN addgroup -g 1001 -S nodejs && \
#     adduser -S nodejs -u 1001 -G nodejs

# RUN npm run build

FROM node:24 AS runtime

WORKDIR /app

# Copy built application from previous stage
COPY --from=build /app ./

# Set environment variables
ENV NODE_ENV=production
EXPOSE 3000

# Switch to non-root user for security
# USER nodejs

# Health check to monitor the application
# HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
#   CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "index.js"]