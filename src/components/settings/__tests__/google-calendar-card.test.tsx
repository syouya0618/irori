/**
 * GoogleCalendarCard（計画書 §7 D-4 / §D-5 のエラーモデルの UI 側）。
 *
 * ここで固定するのは 3 つじゃ:
 *   1. **失敗が UI に出ること**（`?google=` の全コードが文言になる = 握り潰し禁止）
 *   2. **未知値で画面が倒れぬこと**（enum drift 防御。判定は denylist）
 *   3. **トグルが楽観更新し、失敗で巻き戻ること**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react"

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    warning: vi.fn(),
  },
}))

const routerRefresh = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}))

const updateGoogleCalendarSelection = vi.fn()
vi.mock("@/app/(main)/settings/actions", () => ({
  updateGoogleCalendarSelection: (...a: unknown[]) =>
    updateGoogleCalendarSelection(...a),
}))

import {
  GoogleCalendarCard,
  type GoogleConnectionView,
} from "../google-calendar-card"

function connection(
  overrides: Partial<GoogleConnectionView> = {},
): GoogleConnectionView {
  return {
    id: "connection-1",
    googleEmail: "someone@example.test",
    connectionStatus: "active",
    syncStatus: "idle",
    lastErrorKind: null,
    lastSyncedAt: "2026-08-02T01:30:00.000Z",
    calendars: [
      {
        id: "sub-1",
        googleCalendarId: "primary@example.test",
        summary: "メイン",
        isSelected: true,
      },
      {
        id: "sub-2",
        googleCalendarId: "shared@example.test",
        summary: null,
        isSelected: false,
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  updateGoogleCalendarSelection.mockReset()
  updateGoogleCalendarSelection.mockResolvedValue({ success: true })
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("未接続", () => {
  it("接続ボタンを出す（OAuth の start へ遷移する素の <a>）", () => {
    render(<GoogleCalendarCard connections={[]} notice={null} />)
    const link = screen.getByRole("link", {
      name: "Google カレンダーを接続",
    })
    expect(link).toHaveAttribute("href", "/api/google/oauth/start")
  })
})

describe("?google= の通知（握り潰し禁止）", () => {
  // 計画書 §D-5 が名指しする経路は**全て**文言を持たねばならぬ。
  const codes = [
    "connected",
    "connected_no_calendars",
    "missing_scope",
    "no_refresh_token",
    "csrf",
    "denied",
    "invalid_grant",
    "network",
    "not_configured",
    "save_failed",
    "error",
  ]

  for (const code of codes) {
    it(`?google=${code} は利用者向けの文言を出す`, () => {
      render(<GoogleCalendarCard connections={[]} notice={code} />)
      const status = screen.getByRole("status")
      expect(status.textContent?.trim().length ?? 0).toBeGreaterThan(0)
      // 内部コードをそのまま見せぬ（日本語の文言であること）。
      expect(status.textContent).not.toContain(code)
    })
  }

  it("未知の通知コードは何も出さぬ（画面を倒さぬ）", () => {
    render(
      <GoogleCalendarCard connections={[]} notice="brand_new_code_from_future" />,
    )
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("notice が null なら通知を出さぬ", () => {
    render(<GoogleCalendarCard connections={[]} notice={null} />)
    expect(screen.queryByRole("status")).toBeNull()
  })
})

describe("接続済みの表示", () => {
  it("Google アカウントと最終同期時刻を出す", () => {
    render(
      <GoogleCalendarCard connections={[connection()]} notice={null} />,
    )
    expect(screen.getByText("someone@example.test")).toBeInTheDocument()
    // 2026-08-02T01:30Z = JST 10:30
    expect(screen.getByText(/8\/2 10:30/)).toBeInTheDocument()
    expect(screen.getByText(/待機中/)).toBeInTheDocument()
  })

  it("未同期なら「未同期」と出す（0 や空欄で誤魔化さぬ）", () => {
    render(
      <GoogleCalendarCard
        connections={[connection({ lastSyncedAt: null })]}
        notice={null}
      />,
    )
    expect(screen.getByText(/未同期/)).toBeInTheDocument()
  })

  it("summary が無いカレンダーは Google のカレンダー ID を出す（fail-soft）", () => {
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    expect(screen.getByText("shared@example.test")).toBeInTheDocument()
  })

  it("接続が健全なら再連携バナーを出さぬ", () => {
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    expect(screen.queryByText("再連携が必要です")).toBeNull()
  })
})

describe("needs_reauth と enum drift 防御", () => {
  it("connection_status=needs_reauth で再連携バナーと再接続ボタンを出す", () => {
    render(
      <GoogleCalendarCard
        connections={[connection({ connectionStatus: "needs_reauth" })]}
        notice={null}
      />,
    )
    expect(screen.getByText("再連携が必要です")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "再接続" })).toHaveAttribute(
      "href",
      "/api/google/oauth/start",
    )
  })

  it("**未知の connection_status でも再接続導線を出す（denylist）**", () => {
    // allowlist（=== "needs_reauth"）だと DB に新しい異常値が増えた瞬間、
    // その接続が無音で健全扱いになり利用者が復旧できなくなる。
    render(
      <GoogleCalendarCard
        connections={[connection({ connectionStatus: "revoked_by_google" })]}
        notice={null}
      />,
    )
    expect(screen.getByRole("link", { name: "再接続" })).toBeInTheDocument()
    // 嘘の文言（「再連携が必要です」）は出さず、状態名をそのまま見せる。
    expect(screen.queryByText("再連携が必要です")).toBeNull()
    expect(screen.getByText(/revoked_by_google/)).toBeInTheDocument()
  })

  it("未知の sync_status は「不明」へ退化する（throw せぬ）", () => {
    render(
      <GoogleCalendarCard
        connections={[connection({ syncStatus: "throttled_from_future" })]}
        notice={null}
      />,
    )
    expect(screen.getByText(/不明/)).toBeInTheDocument()
  })

  it("未知の last_error_kind は文言を捏造せぬ", () => {
    render(
      <GoogleCalendarCard
        connections={[connection({ lastErrorKind: "brand_new_kind" })]}
        notice={null}
      />,
    )
    expect(screen.queryByText(/brand_new_kind/)).toBeNull()
  })

  it("既知の last_error_kind は文言を出す", () => {
    render(
      <GoogleCalendarCard
        connections={[connection({ lastErrorKind: "quota" })]}
        notice={null}
      />,
    )
    expect(
      screen.getByText(/同期が混み合っています/),
    ).toBeInTheDocument()
  })

  it("壊れた lastSyncedAt でも画面を倒さぬ", () => {
    render(
      <GoogleCalendarCard
        connections={[connection({ lastSyncedAt: "not-a-date" })]}
        notice={null}
      />,
    )
    expect(screen.getByText("someone@example.test")).toBeInTheDocument()
  })
})

describe("カレンダーのトグル", () => {
  it("選択状態を aria-checked で表す", () => {
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    expect(screen.getByRole("switch", { name: /メイン/ })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    expect(
      screen.getByRole("switch", { name: /shared@example.test/ }),
    ).toHaveAttribute("aria-checked", "false")
  })

  it("トグルで Server Action を呼ぶ", async () => {
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("switch", { name: /shared@example.test/ }))
    await waitFor(() => {
      expect(updateGoogleCalendarSelection).toHaveBeenCalledWith("sub-2", true)
    })
  })

  it("業務エラーなら巻き戻してトーストを出す", async () => {
    updateGoogleCalendarSelection.mockResolvedValue({
      error: "カレンダーの設定に失敗しました",
    })
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    const toggle = screen.getByRole("switch", { name: /shared@example.test/ })
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("カレンダーの設定に失敗しました")
    })
    expect(toggle).toHaveAttribute("aria-checked", "false")
  })

  it("圏外 reject でも画面を倒さず巻き戻す", async () => {
    updateGoogleCalendarSelection.mockRejectedValue(new TypeError("fetch failed"))
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    const toggle = screen.getByRole("switch", { name: /メイン/ })
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled()
    })
    expect(toggle).toHaveAttribute("aria-checked", "true")
  })
})

describe("今すぐ同期", () => {
  it("POST /api/google/sync を叩く", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/google/sync",
        expect.objectContaining({ method: "POST" }),
      )
    })
    vi.unstubAllGlobals()
  })

  it("サーバのエラー文言をそのまま出す（握り潰さぬ）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "同期はまだ利用できません" }), {
            status: 501,
          }),
      ),
    )
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("同期はまだ利用できません")
    })
    vi.unstubAllGlobals()
  })

  it("fetch に redirect: 'manual' を渡す（proxy の 307 を追わせぬ）", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, summary: {} }))
    vi.stubGlobal("fetch", fetchMock)
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/google/sync",
      expect.objectContaining({ redirect: "manual" }),
    )
    vi.unstubAllGlobals()
  })

  it("opaqueredirect（proxy の 307）は原因を断定せず再読み込みを促し、成功と言わぬ", async () => {
    // proxy の 307 は未認証（/login）と未承認・profiles の一過性の取得失敗
    // （/pending-approval）を区別できぬ（N1）。「セッション切れ」と断定するのは route の 401 だけ。
    // status 0 は Response のコンストラクタが拒むゆえ素の object で作る。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 0,
        type: "opaqueredirect",
        headers: new Headers(),
        json: async () => {
          throw new SyntaxError("Unexpected end of JSON input")
        },
      })),
    )
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "ログイン状態を確認できませんでした。画面を再読み込みしてください",
      )
    })
    expect(toastError).not.toHaveBeenCalledWith(
      "セッションが切れました。ログインし直してください",
    )
    expect(toastSuccess).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("route の 401 も再ログインを促す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    )
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "セッションが切れました。ログインし直してください",
      )
    })
    expect(toastSuccess).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  /**
   * UX-03: route は 401 を**未認証の時だけ**返す。profiles の一過性の取得失敗は 503、
   * 未承認・世帯なしは 403 じゃ。どれも「ログインし直して」と案内してはならぬ
   * （待てば直る障害で利用者をログアウトへ誘導してしまう）。
   */
  it.each([503, 500])(
    "%i（サーバ側の障害）は時間をおいた再試行を促し、セッション切れとは言わぬ",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("Service Unavailable", { status })),
      )
      render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
      fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))

      await waitFor(() => expect(toastError).toHaveBeenCalled())
      expect(toastError).not.toHaveBeenCalledWith(
        "セッションが切れました。ログインし直してください",
      )
      expect(toastError).toHaveBeenCalledWith(
        "同期に失敗しました。時間をおいてもう一度お試しください",
      )
      expect(toastSuccess).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    },
  )

  it("403（未承認・世帯なし）は事実どおりに伝え、セッション切れとは言わぬ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("承認待ちです", { status: 403 })),
    )
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).not.toHaveBeenCalledWith(
      "セッションが切れました。ログインし直してください",
    )
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("承認されていないか、世帯に参加していません"),
    )
    expect(toastSuccess).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("200 でも本文が ok:true でなければ成功と言わぬ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false })),
    )
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("200 でも JSON でない本文（login 画面の HTML 等）は成功と言わぬ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<!doctype html><title>ログイン</title>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      ),
    )
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("対照: 本文が ok:true なら成功を伝える", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, summary: {} })),
    )
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    expect(toastError).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("通信失敗でもボタンが固まらぬ（永久ローディングにせぬ）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      }),
    )
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    const button = screen.getByRole("button", { name: /今すぐ同期/ })
    fireEvent.click(button)

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("同期に失敗しました")
    })
    expect(button).not.toBeDisabled()
    vi.unstubAllGlobals()
  })
})

describe("Agent C: 状態の言い分け", () => {
  it("接続を読めなかった時は「未接続」と偽らず、接続ボタンも出さぬ", () => {
    render(<GoogleCalendarCard connections={[]} notice={null} connectionsUnknown />)
    expect(screen.getByRole("alert")).toHaveTextContent("未接続とは限りません")
    expect(screen.queryByRole("link", { name: "Google カレンダーを接続" })).toBeNull()
    expect(screen.queryByText("未接続")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }))
    expect(routerRefresh).toHaveBeenCalled()
  })

  it("本当に未接続なら「未接続」の札と接続ボタンを出す（対照）", () => {
    render(<GoogleCalendarCard connections={[]} notice={null} />)
    expect(screen.getByText("未接続")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("カレンダー一覧を読めなかった時は再接続へ誘わぬ", () => {
    render(
      <GoogleCalendarCard
        connections={[connection({ calendars: [], calendarsUnknown: true })]}
        notice={null}
      />,
    )
    expect(screen.getByText(/接続し直す必要はありません/)).toBeInTheDocument()
    expect(screen.queryByText(/もう一度接続してください/)).toBeNull()
  })

  it("接続の札: 健全なら「接続済み」、needs_reauth なら「再接続が必要」、直近の失敗なら「同期エラー」", () => {
    const { unmount } = render(
      <GoogleCalendarCard connections={[connection()]} notice={null} />,
    )
    expect(screen.getByText("接続済み")).toBeInTheDocument()
    unmount()
    render(
      <GoogleCalendarCard
        connections={[connection({ connectionStatus: "needs_reauth" })]}
        notice={null}
      />,
    )
    expect(screen.getByText("再接続が必要")).toBeInTheDocument()
    cleanup()
    render(
      <GoogleCalendarCard
        connections={[connection({ lastErrorKind: "network" })]}
        notice={null}
      />,
    )
    expect(screen.getByText("同期エラー")).toBeInTheDocument()
  })

  it("再接続待ちの接続には同期ボタンを出さず、再接続だけを道にする（同期対象外ゆえ）", () => {
    render(
      <GoogleCalendarCard
        connections={[connection({ connectionStatus: "needs_reauth" })]}
        notice={null}
      />,
    )
    expect(screen.queryByRole("button", { name: /今すぐ同期/ })).toBeNull()
    expect(screen.getByRole("link", { name: "再接続" })).toBeInTheDocument()
  })

  it("未知の connection_status は同期対象のまま（denylist）ゆえボタンを残す", () => {
    render(
      <GoogleCalendarCard
        connections={[connection({ connectionStatus: "revoked_future" })]}
        notice={null}
      />,
    )
    expect(screen.getByRole("button", { name: /今すぐ同期/ })).toBeInTheDocument()
  })

  it("選んでいる件数を見出しに出す", () => {
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    expect(screen.getByText("同期するカレンダー（2件中1件）")).toBeInTheDocument()
  })

  it("切り替えると件数の見出しもすぐ追随し、失敗で巻き戻れば件数も戻る", async () => {
    updateGoogleCalendarSelection.mockResolvedValueOnce({ success: true })
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("switch", { name: /shared@example.test/ }))
    expect(screen.getByText("同期するカレンダー（2件中2件）")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /shared@example.test/ })).toBeEnabled(),
    )

    updateGoogleCalendarSelection.mockResolvedValueOnce({ error: "カレンダーの設定に失敗しました" })
    fireEvent.click(screen.getByRole("switch", { name: /メイン/ }))
    expect(screen.getByText("同期するカレンダー（2件中1件）")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByText("同期するカレンダー（2件中2件）")).toBeInTheDocument(),
    )
  })

  it("最後の 1 つを外して同期し内訳が空なら、失敗ではなく「選ばれていない」と言う", async () => {
    updateGoogleCalendarSelection.mockResolvedValueOnce({ success: true })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          summary: {
            householdId: "h",
            connections: [{ connectionId: "connection-1", needsReauth: false, subscriptions: [] }],
          },
        }),
      ),
    )
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("switch", { name: /メイン/ }))
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /メイン/ })).toHaveAttribute("aria-checked", "false"),
    )
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))
    await waitFor(() => expect(screen.getByText(/選ばれていない/)).toBeInTheDocument())
    vi.unstubAllGlobals()
  })

  it("OAuth の失敗通知には、その場の再接続導線を添える（接続済みの時）", () => {
    render(<GoogleCalendarCard connections={[connection()]} notice="invalid_grant" />)
    expect(screen.getByRole("link", { name: "もう一度接続する" })).toHaveAttribute(
      "href",
      "/api/google/oauth/start",
    )
  })

  it("設定不備（not_configured）には再接続導線を出さぬ（押しても直らぬ）", () => {
    render(<GoogleCalendarCard connections={[connection()]} notice="not_configured" />)
    expect(screen.queryByRole("link", { name: "もう一度接続する" })).toBeNull()
  })

  it("同期の内訳に失敗があれば「完了」と言わず警告し、結果をカードに残す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          summary: {
            householdId: "h",
            connections: [
              {
                connectionId: "connection-1",
                needsReauth: false,
                subscriptions: [
                  { status: "synced", upserted: 1, deleted: 0 },
                  { status: "failed", upserted: 0, deleted: 0 },
                ],
              },
            ],
          },
        }),
      ),
    )
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))
    await waitFor(() =>
      expect(screen.getByText(/2件中1件のカレンダーを同期できませんでした/)).toBeInTheDocument(),
    )
    expect(toastSuccess).not.toHaveBeenCalled()
    // 最終同期時刻と状態はサーバの行から取り直す
    expect(routerRefresh).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("同期中はボタンの文言で示す", async () => {
    let resolve!: (r: Response) => void
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (resolve = r))))
    render(<GoogleCalendarCard connections={[connection()]} notice={null} />)
    fireEvent.click(screen.getByRole("button", { name: /今すぐ同期/ }))
    expect(screen.getByRole("button", { name: /同期中…/ })).toBeDisabled()
    resolve(Response.json({ ok: true }))
    await waitFor(() => expect(screen.getByRole("button", { name: /今すぐ同期/ })).toBeEnabled())
    vi.unstubAllGlobals()
  })
})
