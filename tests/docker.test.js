const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

describe('Docker Configuration', () => {
  const dockerfilePath = path.join(__dirname, '../Dockerfile');
  const dockerignorePath = path.join(__dirname, '../.dockerignore');

  describe('Dockerfile', () => {
    test('should exist and be readable', () => {
      expect(fs.existsSync(dockerfilePath)).toBe(true);
      expect(fs.statSync(dockerfilePath).isFile()).toBe(true);
    });

    test('should use multi-stage build', () => {
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      expect(dockerfile).toContain('FROM node:18-alpine AS builder');
      expect(dockerfile).toContain('FROM node:18-alpine AS production');
    });

    test('should use non-root user', () => {
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      expect(dockerfile).toContain('USER nodejs');
      expect(dockerfile).toContain('adduser -S nodejs -u 1001');
    });

    test('should include health check', () => {
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      expect(dockerfile).toContain('HEALTHCHECK');
      expect(dockerfile).toContain('curl -f http://localhost:3000/health');
    });

    test('should use dumb-init for signal handling', () => {
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      expect(dockerfile).toContain('dumb-init');
      expect(dockerfile).toContain('ENTRYPOINT ["dumb-init", "--"]');
    });

    test('should expose correct port', () => {
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      expect(dockerfile).toContain('EXPOSE 3000');
    });

    test('should set production environment', () => {
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      expect(dockerfile).toContain('ENV NODE_ENV=production');
    });

    test('should copy application files correctly', () => {
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      expect(dockerfile).toContain('COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist');
      expect(dockerfile).toContain('COPY --chown=nodejs:nodejs index.js ./');
    });
  });

  describe('.dockerignore', () => {
    test('should exist and be readable', () => {
      expect(fs.existsSync(dockerignorePath)).toBe(true);
      expect(fs.statSync(dockerignorePath).isFile()).toBe(true);
    });

    test('should exclude sensitive files', () => {
      const dockerignore = fs.readFileSync(dockerignorePath, 'utf8');
      expect(dockerignore).toContain('.env');
      expect(dockerignore).toContain('*.key');
      expect(dockerignore).toContain('*.pem');
      expect(dockerignore).toContain('secrets/');
    });

    test('should exclude development files', () => {
      const dockerignore = fs.readFileSync(dockerignorePath, 'utf8');
      expect(dockerignore).toContain('node_modules/');
      expect(dockerignore).toContain('test/');
      expect(dockerignore).toContain('*.test.js');
      expect(dockerignore).toContain('.git/');
    });

    test('should exclude documentation and logs', () => {
      const dockerignore = fs.readFileSync(dockerignorePath, 'utf8');
      expect(dockerignore).toContain('README.md');
      expect(dockerignore).toContain('docs/');
      expect(dockerignore).toContain('*.log');
    });
  });

  describe('Docker Build Process', () => {
    test('should build successfully', () => {
      try {
        execSync('docker build -t substream-backend:test .', { 
          stdio: 'pipe',
          timeout: 300000 // 5 minutes
        });
        
        // Clean up test image
        execSync('docker rmi substream-backend:test', { stdio: 'pipe' });
        
        expect(true).toBe(true); // If we get here, build succeeded
      } catch (error) {
        fail(`Docker build failed: ${error.message}`);
      }
    }, 300000);

    test('should produce image under 250MB', () => {
      try {
        // Build the image
        execSync('docker build -t substream-backend:size-test .', { 
          stdio: 'pipe',
          timeout: 300000 
        });
        
        // Get image size
        const output = execSync('docker images substream-backend:size-test --format "{{.Size}}"', { 
          encoding: 'utf8',
          stdio: 'pipe'
        }).trim();
        
        // Parse size (e.g., "123.4MB" or "123456KB")
        const sizeMatch = output.match(/^(\d+(?:\.\d+)?)(MB|KB)$/);
        if (sizeMatch) {
          const [, size, unit] = sizeMatch;
          const sizeInMB = unit === 'KB' ? parseFloat(size) / 1024 : parseFloat(size);
          
          expect(sizeInMB).toBeLessThan(250);
        } else {
          fail(`Unable to parse image size: ${output}`);
        }
        
        // Clean up
        execSync('docker rmi substream-backend:size-test', { stdio: 'pipe' });
      } catch (error) {
        fail(`Docker size test failed: ${error.message}`);
      }
    }, 300000);
  });

  describe('Container Runtime Tests', () => {
    let containerId;

    beforeAll(() => {
      try {
        // Build and run container
        execSync('docker build -t substream-backend:runtime-test .', { 
          stdio: 'pipe',
          timeout: 300000 
        });
        
        // Start container
        const output = execSync('docker run -d -p 3001:3000 --name substream-test substream-backend:runtime-test', { 
          encoding: 'utf8',
          stdio: 'pipe'
        }).trim();
        
        containerId = output;
        
        // Wait for container to start
        setTimeout(() => {}, 5000);
      } catch (error) {
        fail(`Failed to start container: ${error.message}`);
      }
    }, 300000);

    afterAll(() => {
      try {
        // Stop and remove container
        execSync('docker stop substream-test', { stdio: 'pipe' });
        execSync('docker rm substream-test', { stdio: 'pipe' });
        execSync('docker rmi substream-backend:runtime-test', { stdio: 'pipe' });
      } catch (error) {
        // Ignore cleanup errors
      }
    });

    test('should respond to health check within 5 seconds', async () => {
      try {
        // Wait for container to be ready
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Check health endpoint
        const response = await fetch('http://localhost:3001/health', {
          timeout: 5000
        });
        
        expect(response.ok).toBe(true);
      } catch (error) {
        fail(`Health check failed: ${error.message}`);
      }
    }, 15000);

    test('should run as non-root user', () => {
      try {
        const output = execSync('docker exec substream-test whoami', { 
          encoding: 'utf8',
          stdio: 'pipe'
        }).trim();
        
        expect(output).toBe('nodejs');
      } catch (error) {
        fail(`Non-root user test failed: ${error.message}`);
      }
    });

    test('should have correct environment variables', () => {
      try {
        const output = execSync('docker exec substream-test env | grep NODE_ENV', { 
          encoding: 'utf8',
          stdio: 'pipe'
        }).trim();
        
        expect(output).toContain('NODE_ENV=production');
      } catch (error) {
        fail(`Environment variable test failed: ${error.message}`);
      }
    });
  });
});
