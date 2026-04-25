import { Injectable, NestMiddleware, Inject } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { TenantRouterService } from '../services/tenant-router.service';
import { DatabaseConnectionFactory } from '../services/database-connection.factory';

@Injectable()
export class TenantDatabaseRoutingMiddleware implements NestMiddleware {
  constructor(
    private readonly tenantRouter: TenantRouterService,
    private readonly dbFactory: DatabaseConnectionFactory,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Extract tenant information from the authenticated user
    const tenantId = this.extractTenantId(req);
    
    if (!tenantId) {
      // No tenant information, proceed with default behavior
      return next();
    }

    try {
      // Check if this is an enterprise tenant
      const isEnterprise = await this.tenantRouter.isEnterpriseTenant(tenantId);
      
      // Attach the appropriate database connection to the request
      req.dbConnection = await this.dbFactory.getConnection(tenantId);
      req.isEnterpriseTenant = isEnterprise;
      req.tenantId = tenantId;

      // Log the routing decision for monitoring
      console.log(`Database routing: Tenant ${tenantId} (${isEnterprise ? 'enterprise' : 'standard'}) routed to appropriate cluster`);

      next();
    } catch (error) {
      console.error(`Database routing error for tenant ${tenantId}:`, error);
      
      // If routing fails, return a server error
      res.status(500).json({
        success: false,
        error: 'Database routing failed',
        message: 'Unable to establish database connection for your tenant',
      });
    }
  }

  /**
   * Extract tenant ID from the authenticated request
   */
  private extractTenantId(req: Request): string | null {
    // Try different methods to extract tenant ID
    
    // 1. From authenticated user (JWT token)
    if (req.user && req.user.tenant_id) {
      return req.user.tenant_id;
    }

    // 2. From request headers (for API key authentication)
    const tenantHeader = req.headers['x-tenant-id'] as string;
    if (tenantHeader) {
      return tenantHeader;
    }

    // 3. From request body (for certain internal operations)
    if (req.body && req.body.tenant_id) {
      return req.body.tenant_id;
    }

    // 4. From query parameters (for read-only operations)
    if (req.query.tenant_id) {
      return req.query.tenant_id as string;
    }

    return null;
  }
}

// Extend Express Request interface to include our custom properties
declare global {
  namespace Express {
    interface Request {
      dbConnection?: any;
      isEnterpriseTenant?: boolean;
      tenantId?: string;
    }
  }
}
