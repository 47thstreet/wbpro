// Set required env vars before any module imports
process.env.WBPRO_PASSWORD = 'test-password-123';
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';
process.env.KARTIS_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.PORT = '0'; // Use random port
process.env.NODE_ENV = 'test';
