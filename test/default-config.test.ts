import { describe, expect, it } from "vitest";

import { defaultRoutingConfig } from "../src/defaultConfig";
import { routeFilesToAgents } from "../src/router";

function agentsFor(file: string): string[] {
  const routed = routeFilesToAgents([file], defaultRoutingConfig);
  return [...routed].filter(([, files]) => files.includes(file)).map(([agent]) => agent);
}

describe("defaultRoutingConfig", () => {
  it.each([
    "src/foo.test.ts",
    "src/__tests__/foo.ts",
    "src/test/java/com/acme/order/OrderServiceTest.java",
    "src/test/groovy/com/acme/order/OrderServiceSpec.groovy",
    "src/test/java/com/acme/order/repository/OrderRepositoryIT.java",
    "src/integrationTest/java/com/acme/order/controller/OrderControllerIT.java",
    "pkg/order/service_test.go",
    "app/orders/test_service.py",
  ])("routes test file %s to tester only", (file) => {
    expect(agentsFor(file)).toEqual(["tester"]);
  });

  it("routes plain production code to clean-coder only", () => {
    expect(agentsFor("src/main/java/com/acme/order/OrderMapper.java")).toEqual(["clean-coder"]);
    expect(agentsFor("src/utils/format.ts")).toEqual(["clean-coder"]);
  });

  it.each([
    "src/main/java/com/acme/order/OrderController.java",
    "src/main/java/com/acme/order/OrderService.java",
    "src/main/java/com/acme/order/messaging/OrderCreatedPublisher.java",
    "src/main/java/com/acme/GlobalExceptionHandler.java",
    "src/api/orders.ts",
  ])("routes service-boundary code %s to clean-coder and architect", (file) => {
    expect(agentsFor(file)).toEqual(["clean-coder", "architect"]);
  });

  it("routes application config to architect", () => {
    expect(agentsFor("src/main/resources/application.yml")).toEqual(["architect"]);
  });

  it("keeps domain and persistence code with their specialists", () => {
    expect(agentsFor("src/main/java/com/acme/order/domain/Order.java")).toEqual([
      "clean-coder",
      "ddd-reviewer",
    ]);
    expect(agentsFor("src/main/java/com/acme/order/OrderRepository.java")).toEqual([
      "clean-coder",
      "performance",
    ]);
  });
});
