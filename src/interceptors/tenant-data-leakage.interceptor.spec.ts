import { Test, TestingModule } from '@nestjs/testing';
import { TenantDataLeakageInterceptor, IgnoreTenantCheck } from './tenant-data-leakage.interceptor';
import { ExecutionContext, CallHandler, Reflector } from '@nestjs/common';
import { of, throwError } from 'rxjs';

describe('TenantDataLeakageInterceptor', () => {
  let interceptor: TenantDataLeakageInterceptor;
  let reflector: Reflector;

  beforeEach(async () => {
    const mockReflector = {
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantDataLeakageInterceptor,
        {
          provide: Reflector,
          useValue: mockReflector,
        },
      ],
    }).compile();

    interceptor = module.get<TenantDataLeakageInterceptor>(TenantDataLeakageInterceptor);
    reflector = module.get<Reflector>(Reflector);
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  describe('intercept', () => {
    let mockContext: ExecutionContext;
    let mockCallHandler: CallHandler;
    let mockRequest: any;

    beforeEach(() => {
      mockRequest = {
        user: { tenant_id: 'tenant-123', address: '0x123...' },
        method: 'GET',
        route: { path: '/api/subscriptions' },
        url: '/api/subscriptions',
        body: {},
      };

      mockContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
        }),
        getHandler: jest.fn(),
      } as any;

      mockCallHandler = {
        handle: jest.fn(),
      };
    });

    it('should allow responses with matching tenant_id', (done) => {
      const responseData = {
        id: 'sub-1',
        tenant_id: 'tenant-123',
        amount: 100,
      };

      mockCallHandler.handle.mockReturnValue(of(responseData));
      reflector.get.mockReturnValue(false);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result).toEqual(responseData);
          done();
        },
        error: done.fail,
      });
    });

    it('should block responses with mismatched tenant_id', (done) => {
      const responseData = {
        id: 'sub-1',
        tenant_id: 'tenant-456', // Different tenant
        amount: 100,
      };

      mockCallHandler.handle.mockReturnValue(of(responseData));
      reflector.get.mockReturnValue(false);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: done.fail,
        error: (error) => {
          expect(error.message).toBe('Internal server error');
          expect(error.getStatus()).toBe(500);
          done();
        },
      });
    });

    it('should allow responses when no user tenant_id is present', (done) => {
      mockRequest.user = null;
      const responseData = {
        id: 'public-data',
        content: 'some public content',
      };

      mockCallHandler.handle.mockReturnValue(of(responseData));
      reflector.get.mockReturnValue(false);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result).toEqual(responseData);
          done();
        },
        error: done.fail,
      });
    });

    it('should bypass validation when IgnoreTenantCheck decorator is used', (done) => {
      const responseData = {
        id: 'sub-1',
        tenant_id: 'tenant-456', // Different tenant
        amount: 100,
      };

      mockCallHandler.handle.mockReturnValue(of(responseData));
      reflector.get.mockReturnValue(true); // Bypass enabled

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result).toEqual(responseData);
          done();
        },
        error: done.fail,
      });
    });

    it('should handle nested objects with tenant_id', (done) => {
      const responseData = {
        user: {
          id: 'user-1',
          tenant_id: 'tenant-123',
        },
        subscription: {
          id: 'sub-1',
          tenant_id: 'tenant-123',
        },
      };

      mockCallHandler.handle.mockReturnValue(of(responseData));
      reflector.get.mockReturnValue(false);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result).toEqual(responseData);
          done();
        },
        error: done.fail,
      });
    });

    it('should block nested objects with mismatched tenant_id', (done) => {
      const responseData = {
        user: {
          id: 'user-1',
          tenant_id: 'tenant-123',
        },
        subscription: {
          id: 'sub-1',
          tenant_id: 'tenant-456', // Different tenant
        },
      };

      mockCallHandler.handle.mockReturnValue(of(responseData));
      reflector.get.mockReturnValue(false);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: done.fail,
        error: (error) => {
          expect(error.message).toBe('Internal server error');
          expect(error.getStatus()).toBe(500);
          done();
        },
      });
    });

    it('should handle arrays with mixed tenant data', (done) => {
      const responseData = [
        { id: 'sub-1', tenant_id: 'tenant-123', amount: 100 },
        { id: 'sub-2', tenant_id: 'tenant-456', amount: 200 }, // Different tenant
      ];

      mockCallHandler.handle.mockReturnValue(of(responseData));
      reflector.get.mockReturnValue(false);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: done.fail,
        error: (error) => {
          expect(error.message).toBe('Internal server error');
          expect(error.getStatus()).toBe(500);
          done();
        },
      });
    });

    it('should handle paginated responses', (done) => {
      const responseData = {
        data: [
          { id: 'sub-1', tenant_id: 'tenant-123', amount: 100 },
          { id: 'sub-2', tenant_id: 'tenant-123', amount: 200 },
        ],
        pagination: {
          page: 1,
          total: 2,
        },
      };

      mockCallHandler.handle.mockReturnValue(of(responseData));
      reflector.get.mockReturnValue(false);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result).toEqual(responseData);
          done();
        },
        error: done.fail,
      });
    });

    it('should handle GraphQL-like nested structures', (done) => {
      const responseData = {
        user: {
          id: 'user-1',
          tenant_id: 'tenant-123',
          subscriptions: {
            edges: [
              {
                node: {
                  id: 'sub-1',
                  tenant_id: 'tenant-123',
                  amount: 100,
                },
              },
            ],
          },
        },
      };

      mockCallHandler.handle.mockReturnValue(of(responseData));
      reflector.get.mockReturnValue(false);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result).toEqual(responseData);
          done();
        },
        error: done.fail,
      });
    });

    it('should pass through existing errors without modification', (done) => {
      const existingError = new Error('Existing error');
      mockCallHandler.handle.mockReturnValue(throwError(() => existingError));
      reflector.get.mockReturnValue(false);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: done.fail,
        error: (error) => {
          expect(error).toBe(existingError);
          done();
        },
      });
    });

    it('should handle null and undefined responses', (done) => {
      mockCallHandler.handle.mockReturnValue(of(null));
      reflector.get.mockReturnValue(false);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result).toBeNull();
          done();
        },
        error: done.fail,
      });
    });

    it('should handle empty arrays', (done) => {
      mockCallHandler.handle.mockReturnValue(of([]));
      reflector.get.mockReturnValue(false);

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result).toEqual([]);
          done();
        },
        error: done.fail,
      });
    });
  });
});
