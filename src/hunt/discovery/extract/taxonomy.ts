/**
 * Skill taxonomy.
 *
 * The previous extractor matched a flat array of 39 names, so a posting that
 * said "Rails", "k8s" or "GenAI" came back with no skills at all. Each entry
 * here is `[canonical, ...aliases]`; matching is alias-driven and canonical
 * names are what gets stored, so "reactjs", "React.js" and "React" collapse to
 * one skill instead of three.
 *
 * Aliases are matched with word boundaries, case-insensitively. Keep them
 * unambiguous — a two-letter alias like "go" needs the boundary rules in
 * `skills.ts` to avoid matching the English verb, and anything shorter than
 * three characters is only matched when it appears uppercase in the source.
 */

export type SkillCategory =
  | 'language'
  | 'frontend'
  | 'backend'
  | 'mobile'
  | 'data'
  | 'ai'
  | 'database'
  | 'cloud'
  | 'devops'
  | 'testing'
  | 'security'
  | 'design'
  | 'product'
  | 'practice'

export interface SkillEntry {
  name: string
  category: SkillCategory
  aliases: string[]
}

/**
 * Canonical names that are ordinary English words or single letters. They stay
 * as the stored name but are never matched literally — only their spelled-out
 * aliases are — because "C", "R" and "Less" appear in almost every posting for
 * reasons that have nothing to do with programming.
 */
const NAME_NOT_MATCHABLE = new Set(['C', 'R', 'Less'])

function group(category: SkillCategory, rows: string[][]): SkillEntry[] {
  return rows.map(([name, ...aliases]) => ({
    name: name as string,
    category,
    aliases: NAME_NOT_MATCHABLE.has(name as string) ? aliases : [name as string, ...aliases],
  }))
}

const LANGUAGES = group('language', [
  ['TypeScript', 'ts'],
  ['JavaScript', 'js', 'ecmascript', 'es6', 'es2015'],
  ['Python'],
  ['Java'],
  ['Kotlin'],
  // Bare "Go" and "C" match ordinary prose ("Go home", "plan C"), so the
  // ambiguous forms are spelled out. `skills.ts` adds a negative lookahead for
  // the remaining bare "Go".
  ['Go', 'golang', 'go programming', 'go language'],
  ['Rust'],
  ['C++', 'cpp', 'c plus plus'],
  ['C#', 'c sharp', 'csharp'],
  // No bare "C": it matches initials, "plan C" and list items. Anything that
  // really means the language nearly always writes C/C++ or "C programming".
  ['C', 'c programming', 'c language', 'c/c++'],
  ['Ruby'],
  ['PHP'],
  ['Swift'],
  ['Objective-C', 'objective c', 'objc'],
  ['Scala'],
  ['Elixir'],
  ['Erlang'],
  ['Haskell'],
  ['Clojure'],
  ['Perl'],
  ['R', 'r programming', 'r language', 'rstudio'],
  ['Julia'],
  ['Dart'],
  ['Lua'],
  ['Groovy'],
  ['Solidity'],
  ['Shell scripting', 'bash', 'shell script', 'zsh scripting'],
  ['PowerShell'],
  ['SQL'],
  ['HTML', 'html5'],
  ['CSS', 'css3'],
])

const FRONTEND = group('frontend', [
  ['React', 'react.js', 'reactjs'],
  ['Next.js', 'nextjs', 'next js'],
  ['Vue.js', 'vue', 'vuejs', 'vue 3'],
  ['Nuxt', 'nuxt.js', 'nuxtjs'],
  ['Angular', 'angularjs', 'angular 2+'],
  ['Svelte', 'sveltekit'],
  ['Solid.js', 'solidjs'],
  ['Remix'],
  ['Astro'],
  ['Redux', 'redux toolkit', 'rtk'],
  ['MobX'],
  ['Zustand'],
  ['React Query', 'tanstack query', 'react-query'],
  ['React Native', 'react-native'],
  ['Tailwind CSS', 'tailwind', 'tailwindcss'],
  ['Sass', 'scss'],
  ['Less', 'less css'],
  ['styled-components', 'styled components'],
  ['Material UI', 'mui', 'material-ui'],
  ['Bootstrap'],
  ['Chakra UI', 'chakra'],
  ['Webpack'],
  ['Vite'],
  ['Rollup'],
  ['esbuild'],
  ['Babel'],
  ['Storybook'],
  ['Web Components'],
  ['WebSockets', 'websocket', 'socket.io', 'socketio'],
  ['WebRTC'],
  ['WebGL'],
  ['Three.js', 'threejs'],
  ['D3.js', 'd3', 'd3js'],
  ['jQuery'],
  ['Accessibility', 'a11y', 'wcag', 'aria'],
  ['Responsive design', 'responsive web design'],
  ['Progressive Web Apps', 'pwa'],
  ['Micro-frontends', 'micro frontend', 'microfrontend'],
  ['Server-side rendering', 'ssr'],
])

const BACKEND = group('backend', [
  ['Node.js', 'nodejs', 'node js', 'node'],
  ['Express.js', 'express', 'expressjs'],
  ['NestJS', 'nest.js', 'nest js'],
  ['Fastify'],
  ['Deno'],
  ['Bun'],
  ['Spring Boot', 'springboot'],
  ['Spring Framework', 'spring'],
  ['Hibernate'],
  ['Micronaut'],
  ['Quarkus'],
  ['Django'],
  ['Flask'],
  ['FastAPI', 'fast api'],
  ['Celery'],
  ['Ruby on Rails', 'rails', 'ror'],
  ['Laravel'],
  ['Symfony'],
  ['ASP.NET', 'asp.net core', 'aspnet'],
  ['.NET', 'dotnet', '.net core'],
  ['Gin'],
  ['Echo framework'],
  ['Phoenix framework'],
  ['GraphQL', 'apollo graphql'],
  ['gRPC'],
  ['REST APIs', 'rest', 'restful', 'rest api'],
  ['tRPC'],
  ['OpenAPI', 'swagger'],
  ['Microservices', 'microservice architecture'],
  ['Event-driven architecture', 'event driven'],
  ['Serverless'],
  ['Message queues', 'message queue', 'pub/sub', 'pubsub'],
  ['Kafka', 'apache kafka'],
  ['RabbitMQ'],
  ['NATS'],
  ['Redis Streams'],
  ['BullMQ', 'bull queue'],
  ['Sidekiq'],
  ['WebHooks', 'webhook'],
  ['Distributed systems'],
  ['System design'],
  ['Multithreading', 'concurrency'],
  ['Caching'],
])

const MOBILE = group('mobile', [
  ['Android'],
  ['iOS'],
  ['SwiftUI'],
  ['UIKit'],
  ['Jetpack Compose', 'jetpack'],
  ['Flutter'],
  ['Xamarin'],
  ['Ionic'],
  ['Expo'],
  ['Mobile testing', 'espresso', 'xctest'],
])

const DATA = group('data', [
  ['Data engineering'],
  ['ETL', 'elt'],
  ['Apache Spark', 'spark', 'pyspark'],
  ['Hadoop'],
  ['Airflow', 'apache airflow'],
  ['dbt'],
  ['Snowflake'],
  ['BigQuery'],
  ['Redshift'],
  ['Databricks'],
  ['Data warehousing', 'data warehouse'],
  ['Data modelling', 'data modeling', 'dimensional modelling'],
  ['Pandas'],
  ['NumPy'],
  ['Data visualisation', 'data visualization'],
  ['Tableau'],
  ['Power BI', 'powerbi'],
  ['Looker'],
  ['Metabase'],
  ['Streaming data', 'stream processing', 'flink', 'apache flink'],
  ['Analytics', 'product analytics'],
  ['A/B testing', 'ab testing', 'experimentation'],
  ['Statistics'],
])

const AI = group('ai', [
  ['Machine Learning', 'ml', 'machine-learning'],
  ['Deep Learning'],
  ['Generative AI', 'gen ai', 'genai', 'generative-ai'],
  ['Large Language Models', 'llm', 'llms'],
  ['LangChain'],
  ['LlamaIndex', 'llama index'],
  ['RAG', 'retrieval augmented generation', 'retrieval-augmented generation'],
  ['Prompt engineering'],
  ['Vector databases', 'vector db', 'pinecone', 'weaviate', 'qdrant', 'chroma'],
  ['OpenAI API', 'openai'],
  ['Anthropic API', 'claude api'],
  ['Hugging Face', 'huggingface', 'transformers library'],
  ['PyTorch', 'torch'],
  ['TensorFlow', 'tensorflow 2'],
  ['Keras'],
  ['scikit-learn', 'sklearn', 'scikit learn'],
  ['MLOps'],
  ['Model deployment', 'model serving'],
  ['Natural Language Processing', 'nlp'],
  ['Computer Vision', 'opencv'],
  ['Recommendation systems', 'recommender systems'],
  ['Feature engineering'],
  ['Fine-tuning', 'fine tuning'],
  ['AI agents', 'agentic', 'agent frameworks'],
])

const DATABASE = group('database', [
  ['PostgreSQL', 'postgres', 'psql'],
  ['MySQL'],
  ['MariaDB'],
  ['SQLite'],
  ['SQL Server', 'mssql', 'ms sql'],
  ['Oracle Database', 'oracle db', 'pl/sql'],
  ['MongoDB', 'mongo'],
  ['DynamoDB'],
  ['Cassandra'],
  ['Redis'],
  ['Memcached'],
  ['Elasticsearch', 'elastic search', 'opensearch'],
  ['Neo4j', 'graph database'],
  ['ClickHouse'],
  ['CockroachDB'],
  ['Supabase'],
  ['Firebase', 'firestore'],
  ['Prisma'],
  ['Drizzle ORM', 'drizzle'],
  ['TypeORM'],
  ['Sequelize'],
  ['SQLAlchemy'],
  ['Database design'],
  ['Query optimisation', 'query optimization', 'query tuning'],
  ['Database migrations'],
])

const CLOUD = group('cloud', [
  ['AWS', 'amazon web services'],
  ['Azure', 'microsoft azure'],
  ['Google Cloud', 'gcp', 'google cloud platform'],
  ['EC2'],
  ['S3'],
  ['Lambda', 'aws lambda'],
  ['ECS'],
  ['EKS'],
  ['CloudFormation'],
  ['CloudFront'],
  ['SQS'],
  ['SNS'],
  ['RDS'],
  ['Vercel'],
  ['Netlify'],
  ['Heroku'],
  ['DigitalOcean'],
  ['Cloudflare', 'cloudflare workers'],
  ['Cloud architecture'],
  ['Cost optimisation', 'cost optimization', 'finops'],
])

const DEVOPS = group('devops', [
  ['Docker', 'containerisation', 'containerization', 'containers'],
  ['Kubernetes', 'k8s'],
  ['Helm'],
  ['Terraform'],
  ['Pulumi'],
  ['Ansible'],
  ['Infrastructure as Code', 'iac'],
  ['CI/CD', 'ci cd', 'continuous integration', 'continuous delivery', 'continuous deployment'],
  ['GitHub Actions'],
  ['GitLab CI', 'gitlab ci/cd'],
  ['Jenkins'],
  ['CircleCI', 'circle ci'],
  ['ArgoCD', 'argo cd'],
  ['Git', 'version control'],
  ['Linux', 'unix'],
  ['Nginx'],
  ['Monitoring', 'observability'],
  ['Prometheus'],
  ['Grafana'],
  ['Datadog'],
  ['Sentry'],
  ['OpenTelemetry', 'otel'],
  ['ELK stack', 'elk'],
  ['Site Reliability Engineering', 'sre'],
  ['Load balancing'],
  ['Performance tuning', 'performance optimisation', 'performance optimization'],
  ['Scalability'],
  ['Incident response', 'on-call', 'on call'],
])

const TESTING = group('testing', [
  ['Unit testing', 'unit tests'],
  ['Integration testing', 'integration tests'],
  ['End-to-end testing', 'e2e testing', 'end to end testing'],
  ['Jest'],
  ['Vitest'],
  ['Mocha'],
  ['Cypress'],
  ['Playwright'],
  ['Selenium'],
  ['JUnit'],
  ['pytest', 'py.test'],
  ['Test-driven development', 'tdd'],
  ['Load testing', 'performance testing', 'k6', 'jmeter'],
  ['Code review'],
])

const SECURITY = group('security', [
  ['Authentication', 'authn'],
  ['Authorisation', 'authorization', 'authz', 'rbac'],
  ['OAuth', 'oauth2', 'oauth 2.0'],
  ['OpenID Connect', 'oidc'],
  ['JWT', 'json web token'],
  ['SAML'],
  ['SSO', 'single sign-on', 'single sign on'],
  ['Encryption', 'cryptography'],
  ['OWASP'],
  ['Penetration testing', 'pen testing'],
  ['Application security', 'appsec'],
  ['Compliance', 'soc 2', 'soc2', 'gdpr', 'hipaa', 'pci dss'],
  ['Secrets management', 'vault'],
])

const DESIGN = group('design', [
  ['Figma'],
  ['Sketch app'],
  ['Adobe XD'],
  ['UI design'],
  ['UX design', 'user experience design'],
  ['Design systems', 'design system'],
  ['Prototyping'],
  ['User research'],
  ['Wireframing'],
])

const PRODUCT = group('product', [
  ['Product management'],
  ['Roadmapping', 'product roadmap'],
  ['Stakeholder management'],
  ['Requirements gathering'],
  ['User stories'],
  ['Technical writing', 'documentation'],
  ['Mentoring', 'mentorship', 'coaching'],
  ['Cross-functional collaboration', 'cross functional'],
])

const PRACTICE = group('practice', [
  ['Agile', 'scrum', 'kanban'],
  ['JIRA'],
  ['Confluence'],
  ['Notion'],
  ['Slack'],
  ['Pair programming'],
  ['Clean code'],
  ['Design patterns'],
  ['Object-oriented programming', 'oop', 'object oriented'],
  ['Functional programming'],
  ['Data structures and algorithms', 'dsa', 'algorithms', 'data structures'],
  ['Refactoring'],
  ['Debugging'],
  ['Problem solving'],
  ['Communication skills', 'strong communication'],
  ['Ownership'],
  ['Startup experience'],
  ['Remote collaboration', 'async collaboration'],
  ['SaaS'],
  ['E-commerce', 'ecommerce'],
  ['Fintech'],
  ['Payments', 'stripe integration', 'payment gateway'],
  ['Healthcare technology', 'healthtech'],
  ['Internationalisation', 'internationalization', 'i18n', 'localisation', 'localization'],
])

/**
 * Non-engineering skills.
 *
 * The remote-job feeds carry plenty of sales, marketing, clinical and
 * operations postings. Without these, a perfectly well-written sales JD came
 * back with zero skills and looked like a scraper failure rather than what it
 * was: a vocabulary gap.
 */
const BUSINESS = group('practice', [
  ['Sales', 'selling', 'quota', 'sales cycle'],
  ['B2B sales', 'b2b'],
  ['SaaS sales'],
  ['Enterprise sales'],
  ['Account management', 'account executive', 'key accounts'],
  ['Business development', 'partnerships'],
  ['Lead generation', 'lead gen', 'prospecting', 'outbound'],
  ['Demand generation', 'demand gen'],
  ['Negotiation'],
  ['CRM'],
  ['Salesforce'],
  ['HubSpot'],
  ['Customer success'],
  ['Customer support', 'customer service'],
  ['Marketing strategy', 'go-to-market', 'gtm'],
  ['SEO', 'search engine optimisation', 'search engine optimization'],
  ['SEM', 'paid search', 'google ads', 'ppc'],
  ['Paid media', 'paid social', 'performance marketing'],
  ['Content marketing', 'content strategy'],
  ['Copywriting', 'copywriter'],
  ['Email marketing', 'lifecycle marketing'],
  ['Social media marketing', 'social media'],
  ['Brand marketing', 'branding'],
  ['Public relations'],
  ['Event management', 'events'],
  ['Program management'],
  ['Project management', 'pmp'],
  ['Operations management', 'business operations'],
  ['Supply chain'],
  ['Logistics'],
  ['Procurement'],
  ['Forecasting'],
  ['Budgeting', 'budget management'],
  ['Financial modelling', 'financial modeling'],
  ['Accounting', 'bookkeeping'],
  ['Payroll'],
  ['Auditing', 'internal audit'],
  ['Underwriting'],
  ['Risk management'],
  ['Recruiting', 'talent acquisition', 'sourcing candidates'],
  ['Onboarding'],
  ['People management', 'team leadership', 'line management'],
  ['Training and development', 'coaching and development'],
  ['Clinical care', 'patient care', 'clinical experience'],
  ['Telehealth', 'telemedicine'],
  ['Mental health treatment', 'psychotherapy', 'counselling', 'counseling'],
  ['Medical records', 'ehr', 'emr'],
  ['Teaching', 'curriculum design', 'instruction'],
  ['Video editing'],
  ['Graphic design'],
  ['Photography'],
  ['Translation', 'localisation services'],
  ['Data entry'],
  ['Customer research', 'market research'],
  ['Presentation skills', 'public speaking'],
  ['English proficiency', 'fluent english', 'native english'],
  ['Writing', 'editing', 'proofreading'],
])

export const SKILL_TAXONOMY: SkillEntry[] = [
  ...LANGUAGES,
  ...FRONTEND,
  ...BACKEND,
  ...MOBILE,
  ...DATA,
  ...AI,
  ...DATABASE,
  ...CLOUD,
  ...DEVOPS,
  ...TESTING,
  ...SECURITY,
  ...DESIGN,
  ...PRODUCT,
  ...PRACTICE,
  ...BUSINESS,
]

/**
 * Categories that describe a technology a candidate either knows or does not.
 *
 * The rest — "Ownership", "Mentoring", "Problem solving", and the whole
 * business group — are things every engineer claims and no posting can really
 * test. Counting them as requirements made postings look far more demanding
 * than they are: a Stripe backend role was marked as needing "Sales" because
 * the word appears in a payments JD.
 */
export const TECHNICAL_CATEGORIES = new Set<SkillCategory>([
  'language', 'frontend', 'backend', 'mobile', 'data', 'ai',
  'database', 'cloud', 'devops', 'testing', 'security',
])

/**
 * Umbrella skills a posting names that a concrete tool on the CV already
 * demonstrates. Someone running Grafana and Prometheus does monitoring; asking
 * them to also list "Monitoring" is the parser's problem, not a gap.
 */
export const IMPLIED_BY: Record<string, string[]> = {
  Monitoring: ['Grafana', 'Prometheus', 'Datadog', 'OpenTelemetry', 'ELK stack'],
  Caching: ['Redis', 'Memcached'],
  Scalability: ['Distributed systems', 'Microservices', 'Kubernetes'],
  'Performance tuning': ['Distributed systems', 'Redis', 'Caching'],
  Docker: ['Kubernetes'],
  'CI/CD': ['Jenkins', 'GitHub Actions', 'GitLab CI', 'CircleCI', 'ArgoCD'],
  'Cloud architecture': ['AWS', 'Azure', 'Google Cloud'],
  SQL: ['PostgreSQL', 'MySQL', 'SQL Server', 'Oracle Database'],
  'Message queues': ['Kafka', 'RabbitMQ', 'BullMQ', 'NATS', 'Redis Streams'],
  'Event-driven architecture': ['Kafka', 'RabbitMQ', 'NATS'],
  'REST APIs': ['Spring Boot', 'Express.js', 'NestJS', 'FastAPI', 'Django'],
  Microservices: ['Kubernetes', 'Docker', 'Spring Boot'],
  'Distributed systems': ['Kafka', 'Kubernetes', 'Microservices'],
  'Infrastructure as Code': ['Terraform', 'Pulumi', 'CloudFormation', 'Ansible'],
  'Unit testing': ['Jest', 'JUnit', 'pytest', 'Vitest', 'Mocha'],
  'Object-oriented programming': ['Java', 'C#', 'C++', 'Kotlin'],
}

/**
 * Aliases that are also ordinary English words, or so short they collide with
 * everything. These only count when the source wrote them in the same case as
 * listed here — "Go" the language, not "go to the careers page".
 */
export const CASE_SENSITIVE_ALIASES = new Set([
  'Go', 'R', 'C', 'ts', 'js', 'ML', 'AI', 'CV', 'ES', 'SQL', 'RAG', 'PWA',
])
