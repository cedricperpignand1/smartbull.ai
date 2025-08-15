"use client";
import { useEffect } from "react";

export default function TradingViewChart({ symbol }: { symbol: string }) {
  useEffect(() => {
    const container = document.getElementById("tradingview_chart");
    if (!container) return;

    // Clear any existing widget
    container.innerHTML = "";

    // Create new script element for TradingView widget
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;

    script.onload = () => {
      // @ts-ignore
      new TradingView.widget({
        container_id: "tradingview_chart",
        autosize: true,
        symbol: symbol,
        interval: "30",
        timezone: "Etc/UTC",
        theme: "light",
        style: "1",
        locale: "en",
      });
    };

    container.appendChild(script);
  }, [symbol]);

  return (
    <div
      id="tradingview_chart"
      style={{ width: "100%", height: "500px", marginTop: "20px" }}
    ></div>
  );
}
