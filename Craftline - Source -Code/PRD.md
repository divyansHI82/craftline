# Product Requirements Document

## Skilled Trade Knowledge Documentation Platform

**Product name:** Craftline  
**Version:** 1.0  
**Status:** Phase 1 project specification

## 1. Product summary

Craftline is a community knowledge platform for skilled trade professionals, students, apprentices, and technicians. It turns practical experience into searchable, structured guides and gives learners a place to discuss, rate, and save useful field knowledge.

## 2. Problem statement

Practical knowledge in electrical work, welding, plumbing, mechanics, HVAC, carpentry, and related trades is often transferred informally. Learners can struggle to find reliable, organized guidance, while experienced workers lack a shared place to document and pass on what they know. Craftline provides a digital library with community contribution and moderation workflows.

## 3. Goals and objectives

### Primary objectives

- Provide a platform for documenting skilled trade knowledge.
- Enable professionals to share tutorials, guides, and practical solutions.
- Support learning for ITI students and apprentices.
- Encourage collaboration between trade professionals and learners.
- Build an organized digital knowledge base for vocational trades.

### Secondary objectives

- Allow users to submit practical guides and tutorials.
- Enable discussion and knowledge exchange on published guides.
- Provide star ratings and helpful feedback.
- Let users bookmark useful tutorials.
- Organize documentation by trade category.

## 4. Users and roles

- **Learner:** Creates an account, searches and browses guides, comments, rates, and bookmarks.
- **Trade contributor:** Maintains a profile, submits practical guides, and participates in discussions.
- **Moderator:** Reviews submissions, manages member access and categories, removes unsuitable content, and views usage data.

All standard accounts are community members. Moderator privileges are assigned from private server configuration and enforced by the server.

## 5. Scope

### Phase 1 in scope

- Account registration, sign-in, sign-out, and profile editing.
- Knowledge feed with keyword search, category filters, recent and helpful sorting, and popular guides.
- Post detail pages with written steps, optional image and tutorial link, safety reminder, comments, ratings, and bookmarks.
- Tutorial creation and submission to a moderator review queue.
- Trade category browsing and category management.
- User dashboard for contributions, submission status, and saved guides.
- Admin panel for guide moderation, user access management, categories, and usage metrics.
- Downloadable CSV usage report.
- Mobile-responsive web interface.

### Out of scope for Phase 1

- Hosting or streaming video files. Guides may link to supported YouTube or Vimeo demonstrations.
- Live workshops or live expert sessions.
- AI-generated troubleshooting advice.
- Native mobile application.
- Contributor certification.

## 6. User journeys

### Learner or professional

1. Register or sign in.
2. Create or update a profile with trade specialization and experience level.
3. Search the feed or browse a trade category.
4. Open a guide and review its steps, safety guidance, and optional media.
5. Comment, rate the guide, mark it helpful, or bookmark it.
6. Return to the dashboard to find saved guides and personal contributions.

### Contributor

1. Sign in.
2. Open Create Tutorial and enter a title, trade, guide type, summary, and step-by-step content.
3. Optionally attach an image and a supported tutorial video link.
4. Confirm safety guidance and submit.
5. Track the submission as pending in the dashboard.
6. After moderator approval, the guide appears in the feed and category pages.

### Moderator

1. Sign in using moderator credentials.
2. Review pending submissions and approve or remove them.
3. Manage community access and trade categories.
4. Review engagement totals and download the usage CSV.

## 7. Functional requirements

### FR-01 Accounts and profiles

- Users can register with name, email, password, trade specialization, and experience level.
- Users can sign in and out and edit their profile.
- Email addresses must be unique; form values must be validated on the server.

### FR-02 Knowledge publishing

- Signed-in members can submit a guide with title, trade category, type, summary, body, optional image, and optional YouTube/Vimeo URL.
- Submissions require safety confirmation and enter a pending state.
- Moderators can approve or remove pending guides.
- Published guides display author, date, reading estimate, category, and engagement information.

### FR-03 Search and discovery

- Visitors can search guide titles, summaries, and content by keyword.
- Visitors can filter guides by trade category.
- The feed can be sorted by recent or helpful and highlights popular guides.

### FR-04 Community interaction

- Signed-in members can add comments to published guides.
- Each member can submit or update a one-to-five-star rating per guide.
- Members can mark a published guide helpful and toggle bookmarks.
- Dashboard shows saved guides and the member’s own contributions.

### FR-05 Administration

- Moderator-only endpoints and screens protect moderation functions.
- Moderators can approve or remove content, pause or restore member access, and add or remove eligible categories.
- The Admin Panel shows published guides, accounts, views, comments, helpful votes, ratings, and bookmarks.
- Moderators can download a CSV report with per-guide usage and rating data.

## 8. Data requirements

- **User:** ID, name, email, password hash and salt, trade, experience level, role, suspended status, join date.
- **Guide:** ID, title, trade, guide type, summary, body, optional image reference, optional video embed URL, author, status, date, views.
- **Comment:** ID, guide, member, text, date.
- **Rating:** Guide, member, integer score from 1 to 5, date; one rating per member per guide.
- **Helpful vote:** Guide and member; one active vote per member per guide.
- **Bookmark:** Guide, member, date; one bookmark per member per guide.
- **Category:** Name and description.

## 9. Non-functional requirements

- **Security:** Passwords are hashed; session tokens are protected; role checks are enforced server-side; inputs and uploads are validated; write requests are protected against cross-origin requests.
- **Privacy:** Moderator secrets and database files must not be committed or distributed.
- **Responsive design:** Core pages and forms adapt to mobile and desktop widths.
- **Reliability:** Local development persists SQLite data on disk; the hosted production setup uses shared PostgreSQL.
- **Performance:** Static assets are served efficiently; guide content remains readable and navigable.
- **Scalability:** Phase 1 supports configurable Node.js worker processes per host (`WEB_CONCURRENCY`, 1–8). Local development uses SQLite; production requires shared PostgreSQL through `DATABASE_URL`, so separate hosts share content, sessions, and rate limits. PostgreSQL pools are bounded, schema initialization uses a database advisory lock, and indexes cover common guide and community queries. Production guide images use Cloudinary object storage. A read-only remote benchmark measures the chosen host; capacity must still be evaluated against the actual hosting plan.
- **Accessibility:** Forms use labels, controls are keyboard focusable, and rating controls expose accessible names and states.

## 10. Technology and deployment

- **Application:** Node.js 24 and Express 5 with HTML, CSS, and JavaScript; built-in cryptography protects passwords and sessions.
- **Database:** SQLite for local development; managed PostgreSQL for production and shared multi-host data.
- **Image storage:** Signed Cloudinary image upload is required in production through server-only environment variables. Local development can store images in SQLite.
- **Deployment target:** Render Blueprint configures the Node.js/Express web service, managed PostgreSQL, and Cloudinary secret prompts. A project owner must connect a repository, set moderator and Cloudinary credentials, and deploy to receive the public URL.

## 11. Success measures

- Number of registered users.
- Number of approved and published knowledge articles.
- Number of guide views.
- Comments and ratings submitted.
- Helpful votes and bookmarks.
- Community contribution rate.

## 12. Assumptions and constraints

### Assumptions

- Skilled professionals are willing to share practical knowledge.
- Students and apprentices will use the platform to learn.
- Community feedback and moderation can improve content quality.

### Constraints

- Content quality depends on contributors and moderator review.
- Moderation may require manual work.
- Community growth depends on member participation.
- A public deployment, Cloudinary storage, and production database upgrades require owner-controlled accounts and credentials.

## 13. Acceptance criteria

- Eight interconnected Phase 1 pages are available: Login, Knowledge Feed, Post Details, Create Tutorial, User Dashboard, Category Page, Admin Panel, and an interactive User Flow page that links each role's journey to the corresponding working pages.
- Users can register and sign in; anonymous users cannot submit, comment, rate, bookmark, or use moderator actions.
- A valid tutorial can be submitted, appears as pending, and becomes visible after moderator approval.
- Search, category browsing, comments, star ratings, helpful votes, bookmarks, and dashboards work with persisted data.
- Moderator functions are restricted by server-side role checks.
- The moderator can download the usage CSV.
- The interface is responsive and includes practical trade examples and safety reminders.
- Automated smoke and persistence checks pass before submission.
- The deployed site has a public URL before final evaluation.
