import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import authService from '../services/authService';
import { validateRegisterInput } from '../validators/authValidator';
import asyncHandler from '../utils/asyncHandler';
import { sendSuccess } from '../utils/responseWrapper';
import type { ILoginPayload } from '../interfaces/IUser';

class AuthController {
  public login = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const loginPayload: ILoginPayload = {
      email: req.body.email,
      password: req.body.password,
    };

    const result = await authService.login(loginPayload);

    sendSuccess(res, result, 'Login successful', StatusCodes.OK);
  });

  public register = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const input = validateRegisterInput(req.body);
    const user = await authService.registerUser(input);

    sendSuccess(res, { user }, 'User registered successfully', StatusCodes.CREATED);
  });
}

export default new AuthController();
