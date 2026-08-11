// Keylink Studio 19-section PRD template, derived from templates/PRD_SKILL.md.
// Each section includes its "include if" guidance so the author can skip
// sections that don't apply. Sections marked ALWAYS INCLUDE are pre-expanded;
// conditional sections start with a one-line note explaining when to include.
export const PRD_TEMPLATE = `# Product Requirements Document

- **Product Name:** (Working Title)
- **Prepared by:** Keylink Innovative Technology (keylinkit.com)
- **Date:**
- **Version:** 1.0
- **Classification:** Internal / Confidential

---

## 1. Executive Summary
<!-- ALWAYS INCLUDE -->

Describe what the app does in 2-3 paragraphs.

**Project Goals:**
-

**Target Users:**
- Primary:
- Secondary:
- Edge case:

**Key Differentiators:**
-

## 2. Design System
<!-- ALWAYS INCLUDE -->

**Color Palette:**
| Color | Hex | Usage |
|-------|-----|-------|
| Primary | # | |
| Secondary | # | |
| Accent | # | |
| Background | # | |
| Text | # | |
| Error | # | |

**Typography:**
- Headings:
- Body:
- Specialized (maps, code, etc.):

**Iconography Approach:**

**Component Library:**
-

## 3. Authentication & User Management
<!-- ALWAYS INCLUDE -->

- **Auth provider:**
- **Registration flow:** (numbered steps)
  1.
  2.
  3.
- **Role hierarchy:**
  - Role 1: permissions
  - Role 2: permissions
- **Session management:** token lifecycle, multi-device, offline caching

## 4. Safety, Compliance & Protected Data
<!-- INCLUDE IF: minors, groups, medical/sensitive data, location tracking, or regulated industry. DELETE this section if none apply. -->

- **Youth Protection:**
- **Medical/Emergency Forms:**
- **Domestic Safety:**
- **Regulatory:** COPPA / GDPR / HIPAA / other

## 5. Feature Requirements
<!-- ALWAYS INCLUDE. Organize by domain. Every requirement gets ID, description, priority (P0/P1/P2), phase. -->

### 5.1 [Domain Name]
| ID | Requirement | Priority | Phase |
|----|-------------|----------|-------|
| DOM-001 | | P0 | 1 |
| DOM-002 | | P1 | 1 |

### 5.2 [Domain Name]
| ID | Requirement | Priority | Phase |
|----|-------------|----------|-------|
| | | | |

## 6. Domestic Safety & Permission Model
<!-- INCLUDE IF: app tracks people's locations. DELETE if not applicable. -->

- **Adult-to-adult rules:**
- **Parent-to-minor rules:**
- **Anti-stalking safeguards:**

## 7. State Machine
<!-- ALWAYS INCLUDE. Define state machines for every major lifecycle. -->

**Primary Workflow:**
\`STATE_A\` -> \`STATE_B\` -> \`STATE_C\`

- STATE_A:
- STATE_B:
- STATE_C:

**User Session:**
\`ANONYMOUS\` -> \`AUTHENTICATED\` -> \`EXPIRED\`

## 8. REST API Specification
<!-- ALWAYS INCLUDE -->

**Base URL:** \`/api/v1\`
**Auth:** Bearer token

### 8.1 [Domain]
| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | /resource | List all | User |
| POST | /resource | Create new | User |

## 9. AI Agents
<!-- INCLUDE IF: app uses AI. DELETE if not applicable. -->

### Agent: [Name]
- **Purpose:**
- **Trigger:**
- **Model:** Claude Sonnet / Haiku
- **Input:**
- **Output:**
- **Fallback:** (non-AI alternative — REQUIRED)
- **Rate limit:**

## 10. Data Model
<!-- ALWAYS INCLUDE -->

### **EntityName**
- id: UUID (PK)
- field: type
- created_at: timestamp
- Relationships:

### **EntityName2**
- id: UUID (PK)
- field: type

## 11. Environment & Infrastructure
<!-- ALWAYS INCLUDE -->

**Backend:**
- Runtime:
- Database:
- Cache:
- Real-time:
- Push notifications:
- Object storage:
- AI:
- External APIs:

**Frontend / Mobile:**
- Framework:
- Map SDK:
- Location services:

**Deployment:** self-hosted Docker Compose (dev), production target TBD

**Environment Variables:**
| Variable | Description | Required |
|----------|-------------|----------|
| | | |

## 12. Docker Compose
<!-- ALWAYS INCLUDE -->

**Services:**
| Service | Image | Port | Depends On |
|---------|-------|------|------------|
| | | | |

**Volumes:**
-

**Networks:**
-

## 13. Seed Data
<!-- ALWAYS INCLUDE. Realistic test data for every entity. -->

- Entity1: 5 sample records
- Entity2: 10 sample records
- Use realistic names, locations, and data from the target context.

## 14. Admin Dashboard
<!-- INCLUDE IF: app has admin or management functions. DELETE if not applicable. -->

**System Admin (Keylink IT):**
-

**Org/Group Admin:**
-

**Self-Service per Role:**
-

## 15. Test Cases & E2E
<!-- ALWAYS INCLUDE -->

**Unit Test Coverage Target:** 80%+

**Integration Test Scenarios:**
1. Input -> Processing -> Expected Output

**E2E Test Scenarios:**
1. [Workflow Name]
   1. Step
   2. Step
   3. Expected result

**Performance Targets:**
- API latency: < ms (p95)
- Throughput: requests/sec
- Battery impact: % per hour (if applicable)

## 16. MVP Phases
<!-- ALWAYS INCLUDE. 2-4 phases with week ranges. -->

### Phase 1 — MVP (Weeks 1-4)
**Goal:**
- Deliverable 1
- Deliverable 2

### Phase 2 — Enhancement (Weeks 5-8)
**Goal:**
- Deliverable 1
- Deliverable 2

## 17. Revenue Model
<!-- INCLUDE IF: app generates revenue. DELETE if internal-only tool. -->

**Primary Revenue:**
- Mechanism:
- Fee structure:
- Example:

**Secondary Revenue:**
-

## 18. Key Considerations & Risks
<!-- ALWAYS INCLUDE -->

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| | High/Med/Low | High/Med/Low | |

**Categories to evaluate:** Privacy & Legal, Battery & Performance, Connectivity & Offline, Platform-Specific, Youth/Group Safety, Scalability, Security.

## 19. Appendix
<!-- ALWAYS INCLUDE -->

**Glossary:**
- Term: Definition

**External API Dependencies:**
-

**Reference Documents:**
-
`;

export const PRD_DOCS_URL =
  'https://github.com/eyaltoledano/claude-task-master/blob/main/docs/examples.md';

export const INVALID_FILE_NAME_CHARACTERS = /[<>:"/\\|?*]/g;
export const PRD_EXTENSION_PATTERN = /\.(txt|md)$/i;
