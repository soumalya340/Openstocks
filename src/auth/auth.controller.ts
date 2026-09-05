import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthService } from "./auth.service.js";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post("token")
  @HttpCode(201)
  @ApiOperation({
    summary: "Issue a demo JWT for a username",
    description: "Creates the user with $100,000 starting cash if the username is new.",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["username"],
      properties: { username: { type: "string", example: "alice" } },
    },
  })
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
