import styles from "../components/Workspace.module.css";

export default function NotFound() {
  return <main className={styles.loading}>
    <h1>没有找到这个页面</h1>
    <p>可以返回文献库，继续阅读和记录。</p>
    <a href="/">返回文献库</a>
  </main>;
}
