"use client";

import { useEffect, useState } from "react";
import Navbar from "../components/Navbar";

interface Row {
  day: string;
  date: string;
  pick: string;
  price: number | "";
  invested: number | "";
  diff: string | ""; // + or -
}

export default function PnlPage() {
  const [rows, setRows] = useState<Row[]>([]);

  // Load saved data on first render
  useEffect(() => {
    const saved = localStorage.getItem("pnlRows");
    if (saved) {
      setRows(JSON.parse(saved));
    } else {
      setRows([
        { day: "Day 1", date: "", pick: "", price: "", invested: "", diff: "" },
        { day: "Day 2", date: "", pick: "", price: "", invested: "", diff: "" },
        { day: "Day 3", date: "", pick: "", price: "", invested: "", diff: "" },
        { day: "Day 4", date: "", pick: "", price: "", invested: "", diff: "" },
        { day: "Day 5", date: "", pick: "", price: "", invested: "", diff: "" },
      ]);
    }
  }, []);

  const saveData = () => {
    localStorage.setItem("pnlRows", JSON.stringify(rows));
    alert("Your P&L has been saved!");
  };

  const addRow = () => {
    const newDay = `Day ${rows.length + 1}`;
    const today = new Date().toISOString().split("T")[0];
    setRows([
      ...rows,
      { day: newDay, date: today, pick: "", price: "", invested: "", diff: "" },
    ]);
  };

  const deleteRow = (index: number) => {
    const updated = [...rows];
    updated.splice(index, 1);
    for (let i = 0; i < updated.length; i++) {
      updated[i].day = `Day ${i + 1}`;
    }
    setRows(updated);
    localStorage.setItem("pnlRows", JSON.stringify(updated));
  };

  const updateCell = (index: number, field: keyof Row, value: string) => {
    const updated = [...rows];
    if (field === "price" || field === "invested") {
      updated[index][field] = value === "" ? "" : parseFloat(value);
    } else {
      updated[index][field] = value;
    }
    setRows(updated);
  };

  const calcSell = (price: number | "") =>
    price === "" ? "" : 1.1 * (price as number);

  const calcProfit = (
    price: number | "",
    sellPrice: number,
    invested: number | "",
    diff: string | ""
  ) => {
    if (price === "" || invested === "" || diff === "") return "";

    const baseProfit =
      (invested / (price as number)) * sellPrice - (invested as number);

    if (diff === "+") return baseProfit;
    if (diff === "-") return -baseProfit;
    return "";
  };

  const totalProfit = rows.reduce((sum, row) => {
    const sellPrice = calcSell(row.price);
    const p = calcProfit(row.price, sellPrice as number, row.invested, row.diff);
    return sum + (typeof p === "number" ? p : 0);
  }, 0);

  return (
    <main>
      <Navbar />
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-6">My P&amp;L</h1>

        <div className="overflow-x-auto rounded-xl shadow-lg border border-gray-200">
          <table className="min-w-full border-collapse">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                {[
                  "Day",
                  "Date",
                  "Pick",
                  "Price (9:30–10am)",
                  "Price to Sell",
                  "Invested",
                  "+/-",
                  "Profit",
                  "Actions",
                ].map((header) => (
                  <th
                    key={header}
                    className="p-3 text-left text-sm font-semibold text-gray-700 border-b border-gray-200"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const sellPrice = calcSell(row.price);
                const profit = calcProfit(
                  row.price,
                  sellPrice as number,
                  row.invested,
                  row.diff
                );

                return (
                  <tr
                    key={i}
                    className={`hover:bg-gray-50 transition ${
                      i % 2 === 0 ? "bg-white" : "bg-gray-50"
                    }`}
                  >
                    <td className="p-3 text-gray-700 font-medium">{row.day}</td>
                    <td className="p-3">
                      <input
                        type="text"
                        value={row.date}
                        onChange={(e) => updateCell(i, "date", e.target.value)}
                        className="w-full bg-transparent border-b border-gray-300 focus:outline-none focus:border-blue-500"
                      />
                    </td>
                    <td className="p-3">
                      <input
                        type="text"
                        value={row.pick}
                        onChange={(e) => updateCell(i, "pick", e.target.value)}
                        className="w-full bg-transparent border-b border-gray-300 focus:outline-none focus:border-blue-500"
                      />
                    </td>
                    <td className="p-3">
                      <input
                        type="number"
                        value={row.price}
                        onChange={(e) => updateCell(i, "price", e.target.value)}
                        className="w-full bg-transparent border-b border-gray-300 focus:outline-none focus:border-blue-500"
                      />
                    </td>
                    <td className="p-3 text-gray-700">
                      {sellPrice !== "" ? (sellPrice as number).toFixed(2) : ""}
                    </td>
                    <td className="p-3">
                      <input
                        type="number"
                        value={row.invested}
                        onChange={(e) =>
                          updateCell(i, "invested", e.target.value)
                        }
                        className="w-full bg-transparent border-b border-gray-300 focus:outline-none focus:border-blue-500"
                      />
                    </td>
                    <td className="p-3">
                      <input
                        type="text"
                        maxLength={1}
                        placeholder="+ or -"
                        value={row.diff}
                        onChange={(e) => updateCell(i, "diff", e.target.value)}
                        className="w-full bg-transparent border-b border-gray-300 focus:outline-none focus:border-blue-500 text-center"
                      />
                    </td>
                    <td
                      className={`p-3 font-semibold ${
                        typeof profit === "number"
                          ? profit >= 0
                            ? "text-green-600"
                            : "text-red-600"
                          : "text-gray-700"
                      }`}
                    >
                      {profit !== "" ? (profit as number).toFixed(2) : ""}
                    </td>
                    <td className="p-3">
                      <button
                        onClick={() => deleteRow(i)}
                        className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 transition"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between mt-6">
          <div className="flex gap-4">
            <button
              onClick={addRow}
              className="px-5 py-2 bg-green-600 text-white rounded-lg shadow hover:bg-green-700 transition"
            >
              + Add Row
            </button>
            <button
              onClick={saveData}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg shadow hover:bg-blue-700 transition"
            >
              Save
            </button>
          </div>
          <div
            className={`text-xl font-bold ${
              totalProfit >= 0 ? "text-green-600" : "text-red-600"
            }`}
          >
            Total: {totalProfit.toFixed(2)}
          </div>
        </div>
      </div>
    </main>
  );
}
