# Local architecture

React, React Router and React Query pages copied from the main manual workspace. Main financial pipeline and pure commitment, spending and history projections are reused. Hosted authentication, PostgreSQL/Redis queue infrastructure and integrations are replaced by local session, SQLite and supervised child-process adapters. The service listens only on 127.0.0.1; source identity and origin checks remain enforced.
