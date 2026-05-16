import { Global, Module } from "@nestjs/common";
import { PortAllocatorService } from "./port-allocator.service";

@Global()
@Module({
  providers: [PortAllocatorService],
  exports: [PortAllocatorService],
})
export class PortsModule {}
