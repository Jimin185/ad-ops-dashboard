import { mockAdapter } from "./mock";

// Production adapters will implement the same interface. Until credentials and
// account mappings are configured, the app deliberately stays in mock mode.
export function getAdapter() {
  if (process.env.ADAPTER_MODE && process.env.ADAPTER_MODE !== "mock") {
    throw new Error("실연동 어댑터가 아직 설정되지 않았습니다. ADAPTER_MODE=mock으로 실행해 주세요.");
  }
  return mockAdapter;
}
