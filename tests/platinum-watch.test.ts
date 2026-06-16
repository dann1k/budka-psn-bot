import assert from "node:assert/strict";
import { selectFreshPlatinums } from "../supabase/functions/telegram-webhook/platinum-watcher.ts";
import type { PsnPolledPlatinum } from "../supabase/functions/telegram-webhook/psn.ts";

function plat(id: string, name = id): PsnPolledPlatinum {
  return {
    npCommunicationId: id,
    npServiceName: "trophy",
    titleName: name,
    platform: "PS5",
    iconUrl: null,
    earnedAt: null
  };
}

function ids(platinums: PsnPolledPlatinum[]): string[] {
  return platinums.map((platinum) => platinum.npCommunicationId);
}

Deno.test("selectFreshPlatinums: возвращает только новые (невиденные) платины", () => {
  const seen = new Set(["NPWR001", "NPWR002"]);
  const current = [plat("NPWR001"), plat("NPWR002"), plat("NPWR003")];

  assert.deepEqual(ids(selectFreshPlatinums(seen, current)), ["NPWR003"]);
});

Deno.test("selectFreshPlatinums: все платины уже виденные → пусто", () => {
  const seen = new Set(["a", "b"]);

  assert.equal(selectFreshPlatinums(seen, [plat("a"), plat("b")]).length, 0);
});

Deno.test("selectFreshPlatinums: пустой снапшот → все платины новые (как при отсутствии baseline)", () => {
  const fresh = selectFreshPlatinums(new Set<string>(), [plat("a"), plat("b")]);

  assert.deepEqual(ids(fresh), ["a", "b"]);
});

Deno.test("selectFreshPlatinums: нет текущих платин → пусто", () => {
  assert.equal(selectFreshPlatinums(new Set(["a"]), []).length, 0);
});

Deno.test("selectFreshPlatinums: сохраняет порядок и объекты входных платин", () => {
  const seen = new Set(["a"]);
  const c = plat("c", "Elden Ring");
  const b = plat("b", "Bloodborne");

  const fresh = selectFreshPlatinums(seen, [plat("a"), b, c]);

  assert.deepEqual(ids(fresh), ["b", "c"]);
  assert.equal(fresh[1], c); // тот же объект, не копия
});
