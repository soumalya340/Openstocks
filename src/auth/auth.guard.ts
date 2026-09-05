import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "./auth.constants.js";
import type { AuthUser } from "./auth.types.js";

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.header("authorization") ?? req.header("Authorization");
    if (!header || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException(
        "Missing or invalid Authorization Bearer token"
      );
    }
    const token = header.slice("Bearer ".length).trim();
    try {
      const payload = jwt.verify(token, JWT_SECRET) as {
        sub: string;
        username: string;
      };
      (req as Request & { user?: AuthUser }).user = {
        userId: payload.sub,
        username: payload.username,
      };
      return true;
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
  }
}
