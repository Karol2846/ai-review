import { type RoutingRuntimeConfig } from "./routingTypes";

/**
 * Test sources. They are routed to `tester` only: every other agent lists test quality as out of
 * scope, so the remaining agents get these globs negated.
 */
const TEST_FILE_GLOBS = [
  "**/{test,tests,__tests__,spec,specs,testFixtures,integrationTest}/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
  "**/*.{test,spec}.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
  "**/*_test.{go,py}",
  "**/test_*.py",
] as const;

function excludingTestFiles(globs: readonly string[]): string[] {
  return [...globs, ...TEST_FILE_GLOBS.map((glob) => `!${glob}`)];
}

export const defaultRoutingConfig = {
  unmatchedFilesPolicy: "skip",
  agentGlobs: {
    "clean-coder": excludingTestFiles([
      "**/src/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/lib/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/app/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/packages/*/src/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
    ]),
    tester: [
      ...TEST_FILE_GLOBS,
      "**/{jest,vitest,mocha,junit,spock,cypress,playwright}.config.{js,cjs,mjs,ts}",
      "**/pom.xml",
      "**/build.gradle",
      "**/build.gradle.kts",
    ],
    // Targets what agents/architect.agent.md reviews (API contracts, exception handling, service
    // and messaging boundaries, external clients, configuration) instead of all production code.
    architect: excludingTestFiles([
      "**/{api,rest,controller,controllers,handler,handlers,routes,router}/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/{config,configuration,module,modules}/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py,yml,yaml,json,properties}",
      "**/{service,services,consumer,consumers,listener,listeners,messaging,client,clients,integration,integrations,adapter,adapters}/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/*{Controller,ControllerAdvice,ExceptionHandler,Service,Consumer,Listener,Client}.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/src/main/resources/**/*.{yml,yaml,properties}",
      "**/application*.{yml,yaml,properties}",
    ]),
    "ddd-reviewer": excludingTestFiles([
      "**/{domain,model,models,aggregate,aggregates,entity,entities,value-object,value-objects,vo,event,events,bounded-context}/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/*{Aggregate,Entity,ValueObject,DomainEvent,DomainService}.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
    ]),
    performance: excludingTestFiles([
      "**/{repository,repositories,dao,daos,persistence,query,queries,sql,cache,caching}/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/*{Repository,Dao,Query,Cache,Client}.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/*.sql",
    ]),
  },
} satisfies RoutingRuntimeConfig;
