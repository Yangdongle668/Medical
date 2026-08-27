import { Component, type ErrorInfo, type ReactNode } from "react";

/* 全局错误边界。
 *
 *  ── 没有它的时候是什么样 ────────────────────────────────────────────
 *  React 18 起，渲染期抛出的异常会让整棵树被卸载 —— 屏幕**全白**，
 *  控制台里有一行堆栈，而用户看到的是"系统坏了"，说不出坏在哪。
 *  一个费率卡页面上的空指针，会把导航、发件箱、登出按钮一起带走。
 *
 *  ── 边界放在哪 ──────────────────────────────────────────────────────
 *  两层：
 *    · 内层包住 <Outlet/>：一个页面炸掉时，**侧栏还在** ——
 *      人还能换一页、还能看见待发条数、还能登出。
 *    · 外层包住整个路由：连壳都炸的时候至少给一句人话和一个重载按钮。
 *
 *  ── 刻意不做的事 ────────────────────────────────────────────────────
 *  不自动重试渲染。同一份 props 再渲染一次通常还是同样的异常，
 *  于是变成一个闪烁的死循环，比白屏更难查。重试由人点。
 */

interface Props { children: ReactNode; scope: string; onReset?: () => void }
interface State { err: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { err: null };

  static getDerivedStateFromError(err: Error): State { return { err }; }

  override componentDidCatch(err: Error, info: ErrorInfo) {
    /* 控制台留全的那一份：componentStack 指得出是哪个组件，
       而 err.stack 在打包之后基本读不出来。 */
    console.error(`[${this.props.scope}] 渲染异常`, err, info.componentStack);
  }

  private reset = () => {
    this.setState({ err: null });
    this.props.onReset?.();
  };

  override render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    return (
      <div className="problem stack" data-testid="error-boundary" style={{ margin: 20 }}>
        <strong>这一页出错了</strong>
        <p className="muted" style={{ margin: 0 }}>
          出错的是界面，不是你刚才做的事 —— 已经发出去的操作不受影响，
          发件箱里待发的那些也还在。
        </p>
        {/* 报障要用的那一句。不展开堆栈：对用户没用，而且可能带上数据。 */}
        <code data-testid="error-boundary-message" style={{ fontSize: 12 }}>
          {err.message || String(err)}
        </code>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" data-testid="error-retry" onClick={this.reset}>
            重试这一页
          </button>
          <button className="btn" onClick={() => location.reload()}>重新加载</button>
        </div>
      </div>
    );
  }
}
