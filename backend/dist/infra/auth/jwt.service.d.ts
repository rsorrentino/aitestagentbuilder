/**
 * JWT Authentication Service
 */
export interface JWTPayload {
    userId: string;
    email: string;
    role: string;
    iat?: number;
    exp?: number;
}
export interface TokenPair {
    accessToken: string;
    refreshToken: string;
}
export declare class JWTService {
    private accessTokenSecret;
    private refreshTokenSecret;
    private accessTokenExpiry;
    private refreshTokenExpiry;
    constructor();
    /**
     * Generate access and refresh token pair
     */
    generateTokens(payload: Omit<JWTPayload, 'iat' | 'exp'>): TokenPair;
    /**
     * Verify access token
     */
    verifyAccessToken(token: string): JWTPayload;
    /**
     * Verify refresh token
     */
    verifyRefreshToken(token: string): {
        userId: string;
    };
    /**
     * Generate API key
     */
    generateApiKey(): string;
    /**
     * Hash API key for storage
     */
    hashApiKey(apiKey: string): string;
    /**
     * Verify API key
     */
    verifyApiKey(apiKey: string, hashedKey: string): boolean;
    private generateSecret;
}
//# sourceMappingURL=jwt.service.d.ts.map