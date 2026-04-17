import { type RoutingRuntimeConfig } from "./routingTypes";

export const defaultRoutingConfig = {
  unmatchedFilesPolicy: "skip",
  userConfigMergeMode: "override",
  invalidUserConfigPolicy: "fallback_with_warning",
  agentGlobs: {
    "clean-coder": [
      "**/src/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/lib/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/app/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/packages/*/src/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
    ],
    tester: [
      "**/{test,tests,__tests__,spec,specs}/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/*.{test,spec}.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/{jest,vitest,mocha,junit,spock,cypress,playwright}.config.{js,cjs,mjs,ts}",
      "**/pom.xml",
      "**/build.gradle",
      "**/build.gradle.kts",
    ],
    architect: [
      "**/{api,rest,controller,controllers,handler,handlers,routes,router}/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/{config,configuration,module,modules}/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py,yml,yaml,json,properties}",
      "**/src/main/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py,yml,yaml,properties}",
    ],
    "ddd-reviewer": [
      "**/{domain,model,models,aggregate,aggregates,entity,entities,value-object,value-objects,vo,event,events,bounded-context}/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/*{Aggregate,Entity,ValueObject,DomainEvent,DomainService}.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
    ],
    performance: [
      "**/{repository,repositories,dao,daos,persistence,query,queries,sql,cache,caching}/**/*.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/*{Repository,Dao,Query,Cache,Client}.{ts,tsx,js,jsx,java,kt,groovy,go,py}",
      "**/*.sql",
    ],
  },
} satisfies RoutingRuntimeConfig;
