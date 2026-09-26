import { Router } from 'express';
import authController from '../controllers/authController';
import validate from '../middleware/validate';
import { loginSchema } from '../validators/authValidator';
import { authLimiter } from '../middlewares/rateLimiter';

const router = Router();

/**
 * @openapi
 * /v1/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Authenticate a user and issue a JWT
 *     description: Verifies email/password credentials and returns a signed JWT along with sanitized user data.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: Login succeeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthSuccessResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         description: Invalid credentials or deactivated account
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/login', authLimiter, validate(loginSchema), authController.login);

/**
 * @openapi
 * /v1/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new user account
 *     description: Creates a user with a hashed password. Emails must be unique.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegisterRequest'
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RegisterSuccessResponse'
 *       400:
 *         description: Invalid registration input
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Email is already in use
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/register', authLimiter, authController.register);

export default router;
