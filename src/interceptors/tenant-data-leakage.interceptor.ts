import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  SetMetadata,
  UseInterceptors,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { Reflector } from '@nestjs/core';
import { Logger } from 'winston';

// Decorator to bypass tenant check for admin endpoints
export const IgnoreTenantCheck = () => SetMetadata('ignoreTenantCheck', true);

@Injectable()
export class TenantDataLeakageInterceptor implements NestInterceptor {
  private readonly logger: Logger;

  constructor(private readonly reflector: Reflector) {
    this.logger = new Logger({
      level: 'error',
      format: 'json',
      transports: [
        new (require('winston').transports.Console)(),
        new (require('winston').transports.File)({ filename: 'logs/security.log' })
      ]
    });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // Check if this endpoint should bypass tenant validation
    const shouldIgnore = this.reflector.get<boolean>(
      'ignoreTenantCheck',
      context.getHandler(),
    );

    if (shouldIgnore) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const userTenantId = request.user?.tenant_id;

    // If no tenant info in request, we can't validate - let it pass through
    // This allows endpoints that don't require tenant authentication
    if (!userTenantId) {
      return next.handle();
    }

    return next.handle().pipe(
      map((response) => {
        // Validate the response for tenant data leakage
        this.validateTenantData(response, userTenantId, context);
        return response;
      }),
      catchError((error) => {
        // Re-throw any existing errors
        return throwError(() => error);
      }),
    );
  }

  private validateTenantData(
    data: any,
    userTenantId: string,
    context: ExecutionContext,
  ): void {
    // Recursively validate all data structures
    this.recursiveValidation(data, userTenantId, context, []);
  }

  private recursiveValidation(
    data: any,
    userTenantId: string,
    context: ExecutionContext,
    path: string[],
  ): void {
    if (data === null || data === undefined) {
      return;
    }

    // Handle arrays
    if (Array.isArray(data)) {
      data.forEach((item, index) => {
        this.recursiveValidation(item, userTenantId, context, [...path, `[${index}]`]);
      });
      return;
    }

    // Handle objects
    if (typeof data === 'object') {
      // Check if this object has a tenant_id property
      if ('tenant_id' in data) {
        const objectTenantId = data.tenant_id;
        
        if (objectTenantId !== userTenantId) {
          const request = context.switchToHttp().getRequest();
          const endpoint = `${request.method} ${request.route?.path || request.url}`;
          const userAddress = request.user?.address || 'unknown';
          
          // Critical security violation detected
          const securityAlert = {
            type: 'CROSS_TENANT_DATA_LEAKAGE',
            severity: 'CRITICAL',
            timestamp: new Date().toISOString(),
            endpoint,
            userAddress,
            userTenantId,
            leakedTenantId: objectTenantId,
            dataPath: path.join('.'),
            stackTrace: new Error().stack,
            requestBody: this.sanitizeRequest(request.body),
          };

          // Log critical alert
          this.logger.error('CRITICAL: Cross-tenant data leakage detected', securityAlert);

          // Trigger P1 alert (in production, this would integrate with monitoring systems)
          this.triggerCriticalAlert(securityAlert);

          // Throw internal server error to prevent data leakage
          throw new InternalServerErrorException('Internal server error');
        }
      }

      // Recursively validate all object properties
      Object.keys(data).forEach((key) => {
        // Skip tenant_id since we already validated it
        if (key === 'tenant_id') return;
        
        this.recursiveValidation(data[key], userTenantId, context, [...path, key]);
      });
    }
  }

  private sanitizeRequest(body: any): any {
    if (!body) return null;
    
    // Remove sensitive data from request body for logging
    const sanitized = { ...body };
    delete sanitized.password;
    delete sanitized.token;
    delete sanitized.secret;
    
    return sanitized;
  }

  private triggerCriticalAlert(alert: any): void {
    // In production, this would integrate with PagerDuty, Slack, etc.
    console.error('🚨 P1 SECURITY ALERT 🚨', JSON.stringify(alert, null, 2));
    
    // For now, just ensure it's logged prominently
    if (process.env.NODE_ENV === 'production') {
      // Send to external monitoring service
      // Example: pagerDuty.trigger(alert);
    }
  }
}

// Helper decorator for easy application
export function TenantDataLeakageProtection() {
  return UseInterceptors(TenantDataLeakageInterceptor);
}
