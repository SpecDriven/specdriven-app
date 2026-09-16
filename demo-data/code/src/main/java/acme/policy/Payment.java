package acme.policy;

import java.math.BigDecimal;
import java.time.LocalDate;

/** One premium payment against a policy. */
public record Payment(String policyNumber, BigDecimal amount, LocalDate paidOn, String method) {}
