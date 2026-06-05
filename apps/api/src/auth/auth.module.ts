import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { CliTokenStrategy } from "./cli-token.strategy";
import { GoogleAuthController } from "./google.controller";
import { GoogleStrategy } from "./google.strategy";
import { JwtStrategy } from "./jwt.strategy";
import { DemoModule } from "../demo/demo.module";

@Module({
  imports: [
    DemoModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>("INTERNAL_JWT_SECRET");
        if (!secret) {
          throw new Error(
            "INTERNAL_JWT_SECRET is not set — configure it in apps/api/.env"
          );
        }
        return { secret };
      },
    }),
  ],
  controllers: [AuthController, GoogleAuthController],
  providers: [AuthService, JwtStrategy, GoogleStrategy, CliTokenStrategy],
  exports: [PassportModule, JwtModule, AuthService],
})
export class AuthModule {}
