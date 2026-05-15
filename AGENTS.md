# Agent Notes

## PSN API Reference

- This bot uses `npm:psn-api@2.18.0` at runtime from the Supabase Edge Function code.
- The upstream source for that exact library version is vendored as a squash git subtree in `vendor/psn-api`.
- Treat `vendor/psn-api` as read-only reference code. Do not import runtime bot code from it and do not edit it for bot fixes.
- When working on PSN features, inspect `vendor/psn-api/src` first for exported functions, response models, auth helpers, and error behavior.
- Keep runtime imports pinned to npm unless the user explicitly asks to fork or patch `psn-api`.
- To update the reference subtree, use:

```bash
git subtree pull --prefix=vendor/psn-api https://github.com/achievements-app/psn-api.git v2.18.0 --squash
```

- If the bot upgrades `npm:psn-api`, update this subtree to the matching upstream tag in the same change.
