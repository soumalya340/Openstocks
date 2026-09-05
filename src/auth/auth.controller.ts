import { BadRequestException, Body, Controller, HttpCode, Post } from "@nestjs/common";
import { AuthService } from "./auth.service.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("token")
  @HttpCode(201)
  async issueToken(@Body() body: { username?: unknown }) {
    const username = String(body?.username ?? "").trim();
    if (!username) {
      throw new BadRequestException("username is required");
    }
    const user = await this.authService.ensureUser(username);
    const token = this.authService.issueToken(user);
    return {
      token,
      userId: user.userId,
      username: user.username,
      tokenType: "Bearer",
    };
  }
}
