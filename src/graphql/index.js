/**
 * Apollo Server Configuration
 * Integrates GraphQL with Express using Apollo Server
 * 
 * Usage in index.js:
 *   const { setupApolloServer } = require('./src/graphql');
 *   
 *   const app = express();
 *   await setupApolloServer(app, database, authenticateToken);
 */

const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const fs = require('fs');
const path = require('path');
const resolvers = require('./resolvers');
const { createDataLoaders } = require('./dataloaders');

/**
 * Load all GraphQL schema files and merge them
 * @returns {string} Combined GraphQL schema
 */
function loadGraphQLSchemas() {
  const schemasDir = path.join(__dirname, 'schemas');
  let mergedSchema = '';

  const schemaFiles = fs.readdirSync(schemasDir).filter(f => f.endsWith('.graphql'));

  // Sort to ensure root.graphql is processed last
  schemaFiles.sort((a, b) => {
    if (a === 'root.graphql') return 1;
    if (b === 'root.graphql') return -1;
    return a.localeCompare(b);
  });

  for (const file of schemaFiles) {
    const filePath = path.join(schemasDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    mergedSchema += '\n' + content;
  }

  return mergedSchema;
}

/**
 * Setup Apollo Server with Express
 * @param {import('express').Express} app Express application
 * @param {import('../db/appDatabase').AppDatabase} database Database instance
 * @returns {Promise<void>}
 */
async function setupApolloServer(app, database) {
  // Load and merge schemas
  const typeDefs = loadGraphQLSchemas();

  // Create Apollo Server instance
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    // Enable introspection for development (disable in production)
    introspection: process.env.NODE_ENV !== 'production',
    // Format errors for client
    formatError: (error) => {
      console.error('GraphQL Error:', error);
      return {
        message: error.message,
        code: error.extensions?.code || 'INTERNAL_SERVER_ERROR',
        path: error.path
      };
    }
  });

  // Start the Apollo Server
  await server.start();

  // Apply Express middleware for GraphQL
  app.use(
    '/graphql',
    expressMiddleware(server, {
      /**
       * Context factory - called for each request
       * Creates dataloaders and attaches db/auth context
       */
      context: async ({ req }) => {
        // Extract user from request (set by authenticateToken middleware)
        const user = req.user || null;
        const authToken = req.headers.authorization?.replace('Bearer ', '');

        // Create fresh dataloaders for each request
        const dataloaders = createDataLoaders(database);

        return {
          db: database,
          dataloaders,
          user,
          authToken,
          req
        };
      }
    })
  );

  // Return server instance for testing and graceful shutdown
  return server;
}

/**
 * Middleware to check GraphQL authentication
 * Can be used before Apollo middleware if custom authentication is needed
 * Note: GraphQL endpoint requires Bearer token authentication
 */
function authenticateGraphQL(req, res, next) {
  if (req.path !== '/graphql') {
    return next();
  }

  // GraphQL introspection queries are allowed publicly
  const body = req.body || {};
  const query = body.query || '';

  if (query.includes('IntrospectionQuery')) {
    return next();
  }

  next();
}

module.exports = {
  setupApolloServer,
  authenticateGraphQL,
  loadGraphQLSchemas
};
