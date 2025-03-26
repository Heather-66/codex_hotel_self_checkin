<?php
// Enable error reporting for debugging
error_reporting(E_ALL);
ini_set('display_errors', 1);
 
// Check if form is submitted
if ($_SERVER["REQUEST_METHOD"] == "POST") {
 
    // Get input values
    $visaCardNumber = intval($_POST['visaCardNumber']); // Ensure integer
    $cardHolderName = $_POST['cardHolderName']; // String
    $expireMonth = intval($_POST['expireMonth']);  // Ensure integer
    $expireYear = intval($_POST['expireYear']);  // Ensure integer
    $cvc = intval($_POST['cvc']);  // Ensure integer
 
    // Connect to MySQL
    $conn = new mysqli('localhost', 'root', '', 'checkin');
 
    // Check connection
    if ($conn->connect_error) {
        die('Connection Failed: ' . $conn->connect_error);
    }
 
    // Prepare SQL statement
    $stmt = $conn->prepare("INSERT INTO visainfo (visaCardNumber, cardHolderName, expireMonth, expireYear, cvc) VALUES (?, ?, ?, ?, ?)");
    $stmt->bind_param("isiii", $visaCardNumber, $cardHolderName, $expireMonth, $expireYear, $cvc);
 
    // Execute statement and check for errors
    if ($stmt->execute()) {
        echo "Registration successfully saved!";
    } else {
        echo "Error: " . $stmt->error;
    }
 
    // Close statement and connection
    $stmt->close();
    $conn->close();
} else {
    echo "Form not submitted correctly.";
}
?>