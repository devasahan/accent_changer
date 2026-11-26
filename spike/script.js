/**
 * Fifteen interview-style sentences with the words accent conversion tends to
 * trip on. Fifteen, so the blind listener can hear five different lines from
 * each of three runs (lines 1-5, 6-10, 11-15) and never the same sentence twice.
 */
export const DEFAULT_SCRIPT = [
  "Hi, thanks for having me. I'm a backend developer with six years of experience.",
  "Most recently I built a payment service in Go, running on Kubernetes and PostgreSQL.",
  "We cut the p95 latency from eight hundred milliseconds to one hundred and twenty.",
  "I designed idempotent REST APIs and used OAuth two with JWT tokens.",
  "Our CI/CD pipeline used GitHub Actions, Docker and Terraform on AWS.",
  "I mentor two junior engineers and lead our weekly architecture review.",
  "One tricky bug was a race condition in our Kafka consumer; we fixed it with retries and a dead-letter queue.",
  "I'm comfortable with Python, TypeScript and a little Rust.",
  "I'd like to work remotely from Europe, and I can start in thirty days.",
  "Do you have any questions about my experience with distributed systems?",
  "In my last role I owned the on-call rotation and wrote most of our runbooks.",
  "We moved three services from a monolith to gRPC, without any downtime.",
  "I measure everything: Prometheus for metrics, Grafana dashboards and OpenTelemetry traces.",
  "My expected salary is around sixty-five thousand euros, depending on the package.",
  "Thank you for your time; I'm really looking forward to hearing from you.",
].join("\n");
