import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { User } from '../users/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { VerifyChallengeDto } from './dto/verify-challenge.dto';
import { RateLimitService } from './rate-limit.service';

const mockAuthService = () => ({
  generateChallenge: jest
    .fn()
    .mockImplementation(
      (address: string) => `InsightArena:nonce:1234567890:randomhex:${address}`,
    ),
  verifyChallenge: jest.fn(),
  verifyStellarSignature: jest.fn(),
  refreshToken: jest.fn(),
});

const mockConfigService = () => ({
  get: jest.fn().mockReturnValue('7d'),
});

describe('AuthController', () => {
  let controller: AuthController;
  let authService: ReturnType<typeof mockAuthService>;
  let configService: ReturnType<typeof mockConfigService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService() },
        {
          provide: RateLimitService,
          useValue: { getStatus: jest.fn() },
        },
        { provide: ConfigService, useValue: mockConfigService() },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get(AuthService);
    configService = module.get(ConfigService);
  });

  describe('generateChallenge', () => {
    it('returns a challenge string for a valid stellar_address', () => {
      const result = controller.generateChallenge({ stellar_address: 'GABC' });
      expect(authService.generateChallenge).toHaveBeenCalledWith('GABC');
      expect(result.challenge).toMatch(/^InsightArena:nonce:/);
    });
  });

  describe('verifyChallenge', () => {
    const dto: VerifyChallengeDto = {
      stellar_address: 'GABC123XYZ',
      signed_challenge: 'aabbcc',
    };

    it('returns { access_token, user } on valid input', async () => {
      const user = Object.assign(new User(), {
        id: 'uuid-1',
        stellar_address: dto.stellar_address,
      });
      authService.verifyChallenge.mockResolvedValue({
        access_token: 'signed.jwt.token',
        user,
      });

      const result = await controller.verifyChallenge(dto);

      expect(authService.verifyChallenge).toHaveBeenCalledWith(
        dto.stellar_address,
        dto.signed_challenge,
      );
      expect(result).toEqual({ access_token: 'signed.jwt.token', user });
    });

    it('propagates UnauthorizedException from the service (invalid signature)', async () => {
      authService.verifyChallenge.mockRejectedValue(
        new UnauthorizedException('Invalid signature'),
      );

      await expect(controller.verifyChallenge(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('propagates UnauthorizedException from the service (expired nonce)', async () => {
      authService.verifyChallenge.mockRejectedValue(
        new UnauthorizedException(
          'No valid challenge found or challenge expired',
        ),
      );

      await expect(controller.verifyChallenge(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('propagates UnauthorizedException from the service (replay attack)', async () => {
      authService.verifyChallenge.mockRejectedValue(
        new UnauthorizedException('Challenge already used'),
      );

      await expect(controller.verifyChallenge(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('verifyWallet', () => {
    it('should return { verified: true } for a valid signature', () => {
      const dto = {
        stellar_address: 'G...Address',
        challenge: 'InsightArena:dispute:123',
        signature: 'a1b2c3d4',
      };
      authService.verifyStellarSignature.mockReturnValue(true);

      const result = controller.verifyWallet(dto);

      expect(result).toEqual({ verified: true });
      expect(authService.verifyStellarSignature).toHaveBeenCalledWith(
        dto.stellar_address,
        dto.challenge,
        dto.signature,
      );
    });

    it('should return { verified: false } for an invalid signature', () => {
      const dto = {
        stellar_address: 'G...Address',
        challenge: 'InsightArena:dispute:123',
        signature: 'wrong-signature',
      };
      authService.verifyStellarSignature.mockReturnValue(false);

      const result = controller.verifyWallet(dto);

      expect(result).toEqual({ verified: false });
    });
  });

  describe('refreshToken', () => {
    it('should return new access token with expiry for authenticated user', async () => {
      const user = Object.assign(new User(), {
        id: 'user-123',
        stellar_address: 'GABC',
      });

      authService.refreshToken.mockResolvedValue({
        access_token: 'new.jwt.token',
      });

      const result = await controller.refreshToken(user);

      expect(result.access_token).toBe('new.jwt.token');
      expect(result.expires_at).toBeDefined();
      expect(authService.refreshToken).toHaveBeenCalledWith('user-123');
    });

    it('should calculate correct expiry timestamp for 7d token', async () => {
      const user = Object.assign(new User(), {
        id: 'user-123',
        stellar_address: 'GABC',
      });

      authService.refreshToken.mockResolvedValue({
        access_token: 'new.jwt.token',
      });
      configService.get.mockReturnValue('7d');

      const before = Date.now();
      const result = await controller.refreshToken(user);
      const after = Date.now();

      const expiresAt = new Date(result.expires_at).getTime();
      const expected7Days = 7 * 24 * 60 * 60 * 1000;

      expect(expiresAt).toBeGreaterThanOrEqual(before + expected7Days);
      expect(expiresAt).toBeLessThanOrEqual(after + expected7Days);
    });

    it('should propagate UnauthorizedException if user is deleted', async () => {
      const user = Object.assign(new User(), {
        id: 'deleted-user',
        stellar_address: 'GABC',
      });

      authService.refreshToken.mockRejectedValue(
        new UnauthorizedException('User not found or has been deleted'),
      );

      await expect(controller.refreshToken(user)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should handle different expiry formats', async () => {
      const user = Object.assign(new User(), {
        id: 'user-123',
        stellar_address: 'GABC',
      });

      authService.refreshToken.mockResolvedValue({
        access_token: 'new.jwt.token',
      });

      // Test 24h format
      configService.get.mockReturnValue('24h');
      const result24h = await controller.refreshToken(user);
      expect(result24h.expires_at).toBeDefined();

      // Test 60m format
      configService.get.mockReturnValue('60m');
      const result60m = await controller.refreshToken(user);
      expect(result60m.expires_at).toBeDefined();

      // Test 3600s format
      configService.get.mockReturnValue('3600s');
      const result3600s = await controller.refreshToken(user);
      expect(result3600s.expires_at).toBeDefined();
    });
  });
});
