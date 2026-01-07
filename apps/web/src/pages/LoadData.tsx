import { FC } from "react";
import { useState } from "react";



export const LoadDataPage: FC = () => {
  const [randomNumber, setRandomNumber] = useState(0);

  const handleIngestClick = () => {
    /*
    console.log("ingest clicked");
    let data = getRemoteData();
    */
    const newNumber = Math.floor(Math.random() * 100);
    setRandomNumber(newNumber);
  };

  const getRemoteData = () => {
    return "{test: 'test'}";
  }

  return (
    <div>
      <h1 className="page-title">Load Data</h1>
      <button onClick={handleIngestClick} className="btn primary">
        Start Ingest
      </button>
      <p>Random Number: {randomNumber}</p>
    </div>
  );
};