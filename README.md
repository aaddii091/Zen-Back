# Zen-Back

This project is a Node.js/Express backend providing user authentication and quiz management.

## Support Tickets

Two new endpoints are available to create and retrieve support tickets:

- `POST /api/v1/tickets` – create a ticket. Requires authentication. Body fields: `title`, `message`, optional `file` and `organization`.
- `GET /api/v1/tickets` – retrieve tickets. Non-admin users receive only their own tickets. Admins receive all tickets. Results can be filtered by organization using the `organization` query parameter.
