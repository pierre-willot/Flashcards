console.log("Hello from script.js!");
fetch("json/data.json")
  .then(response => response.json())
  .then(data => console.log("Loaded data:", data));
